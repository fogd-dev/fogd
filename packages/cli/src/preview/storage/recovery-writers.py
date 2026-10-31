"""Observe scoped Docker writers without stopping or reconfiguring any resource."""


def recovery_docker_rows(command, format_string, pattern, field):
    names = sorted(run(['docker', '--host', 'unix:///var/run/docker.sock', *command]).split())
    require(len(names) <= 1024 and all(re.fullmatch(pattern, name) for name in names))
    if not names:
        return []
    output = run(['docker', '--host', 'unix:///var/run/docker.sock', *(['volume', 'inspect'] if field == 'name' else ['inspect']), '--format', format_string, *names])
    rows = [json.loads(line) for line in output.splitlines()]
    require(sorted(row[field] for row in rows) == names)
    require(names == sorted(run(['docker', '--host', 'unix:///var/run/docker.sock', *command]).split()))
    return rows


def recovery_path_overlap(path, aliases):
    if not isinstance(path, str) or not path.startswith('/'):
        return False
    path = os.path.realpath(path)
    return any(path == item or path.startswith(item + '/') or item.startswith(path.rstrip('/') + '/') for item in aliases)


def recovery_references(row, volumes, aliases):
    mounts = (row['mounts'] or []) + (row['specs'] or [])
    paths = [mount.get('Source') for mount in mounts]
    names = [mount.get('Name') or mount.get('Source') for mount in mounts]
    for bind in row['binds'] or []:
        source = bind.split(':', 1)[0]
        paths.append(source); names.append(source)
    return any(name in volumes for name in names) or any(recovery_path_overlap(path, aliases) for path in paths)


def assert_no_recovery_writers(value, loop):
    aliases = [value['directory'], paths(value)[0]] + ([loop['name']] if loop else [])
    volumes = recovery_docker_rows(['volume', 'ls', '--quiet'],
        '{"name":{{json .Name}},"driver":{{json .Driver}},"options":{{json .Options}}}', r'[A-Za-z0-9][A-Za-z0-9_.-]{0,254}', 'name')
    blocked = set()
    for volume in volumes:
        device = (volume['options'] or {}).get('device')
        if volume['driver'] != 'local' or device == 'UUID=' + value['uuid'] or recovery_path_overlap(device, aliases):
            blocked.add(volume['name'])
    containers = recovery_docker_rows(['ps', '--all', '--quiet', '--no-trunc'],
        '{"id":{{json .Id}},"running":{{json .State.Running}},"pid":{{json .State.Pid}},"status":{{json .State.Status}},"restart":{{json .HostConfig.RestartPolicy.Name}},"privileged":{{json .HostConfig.Privileged}},"devices":{{json (index .HostConfig "Devices")}},"rules":{{json (index .HostConfig "DeviceCgroupRules")}},"mounts":{{json .Mounts}},"binds":{{json (index .HostConfig "Binds")}},"specs":{{json (index .HostConfig "Mounts")}}}', r'[a-f0-9]{64}', 'id')
    for row in containers:
        unsafe = row['privileged'] or row['devices'] or row['rules']
        if unsafe or recovery_references(row, blocked, aliases):
            require(row['running'] is False and row['pid'] == 0 and row['status'] in ['created', 'exited', 'dead'] and row['restart'] == 'no')
