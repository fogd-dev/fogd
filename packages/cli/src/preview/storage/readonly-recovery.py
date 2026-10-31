"""Explicit read-only data access. Never format, replay an uncertain mount or authorize execution."""


def readonly_mount_rows():
    return json.loads(run(['findmnt', '--json', '--list', '--output', 'TARGET,SOURCE,FSTYPE,UUID,OPTIONS,FSROOT,MAJ:MIN']))['filesystems']


def readonly_loop(value):
    rows = json.loads(run(['losetup', '--json', '--list', '--output', LOOP_FIELDS]))['loopdevices']
    matches = [row for row in rows if row['back-file'] == paths(value)[0]]
    require(len(matches) <= 1)
    return checked_loop_binding(value, matches[0]) if matches else None


def recovery_original(value):
    value, original = storage_origin(value)
    require(original['schema'] == 2)
    digest = hashlib.sha256((json.dumps(original, ensure_ascii=False, indent=2) + '\n').encode()).hexdigest()
    require(digest == value['storageSha256'])
    policy = read_policy(value)
    rows, quarantines = storage_inventory(value, policy)
    held = next(row for row in rows if row['project'] == value['project'])
    require(original['admission']['profileId'] == policy['id'] and original['admission']['chargeBytes'] == CHARGE_BYTES)
    if value['project'] not in {row['project'] for row in quarantines}:
        require(original['admission']['reservation'] == held['reservation'])
    value = {**value, 'effectiveAdmission': {key: held[key] for key in ['profileId', 'reservation', 'chargeBytes']}}
    return value, original


def verify_recovery_image(value):
    fd = os.open(paths(value)[0], os.O_RDONLY | os.O_NOFOLLOW)
    try:
        require(os.fstat(fd).st_ino == disk_state(value)['inode'])
        output = subprocess.run(['blkid', '-p', '-s', 'UUID', '-s', 'TYPE', '-o', 'export', '/proc/self/fd/' + str(fd)],
                                pass_fds=[fd], check=True, capture_output=True, text=True, env=ENV, timeout=30).stdout
        fields = dict(line.split('=', 1) for line in output.splitlines() if '=' in line)
        require(fields.get('UUID') == value['uuid'] and fields.get('TYPE') == 'ext4')
    finally:
        os.close(fd)


def checked_readonly_mount(value, loop, row):
    require(set(row) == {'target', 'source', 'fstype', 'uuid', 'options', 'fsroot', 'maj:min'})
    require(row['source'] == loop['name'] and row['fstype'] == 'ext4' and row['uuid'] == value['uuid']
            and row['fsroot'] == '/' and row['maj:min'] == loop['maj:min'])
    options = set(row['options'].split(','))
    require({'ro', 'nosuid', 'nodev', 'noexec', 'relatime'} <= options
            and options <= {'ro', 'nosuid', 'nodev', 'noexec', 'relatime', 'noload', 'norecovery'}
            and options & {'noload', 'norecovery'})


def readonly_mount(value, loop, mounted):
    mount = paths(value)[1]
    primary = [row for row in mounted if row['target'] == mount]
    require(len(primary) == 1)
    expected = identity(mount, True)
    for row in mounted:
        checked_readonly_mount(value, loop, row)
        require(identity(row['target'], True) == expected)  # Host bind aliases must expose the same read-only root.
    facts = os.statvfs(mount)
    require(facts.f_frsize == 4096 and 0 < facts.f_blocks * facts.f_frsize <= BYTES and facts.f_files == 65536)
    return primary[0]


def readonly_report(value, original, pending):
    loop = readonly_loop(value)
    require(loop is not None)
    mounted = [row for row in readonly_mount_rows() if row['maj:min'] == loop['maj:min']]
    mount = readonly_mount(value, loop, mounted)
    return {'schema': 1, 'kind': 'fogd-preview-storage-readonly-recovery', 'id': value['recoveryId'],
            'operation': pending['fence']['record']['operation'], 'project': value['project'], 'engineId': value['engineId'],
            'originalStorageSha256': value['storageSha256'], 'uuid': value['uuid'], 'admission': value['effectiveAdmission'],
            'rootIdentity': value['rootIdentity'], 'directoryIdentity': identity(value['directory'], True),
            'disk': disk_state(value), 'loop': loop, 'mount': mount, 'roles': storage_roles(value, original),
            'readOnly': True, 'resourcesRetained': True, 'executionAuthorized': False, 'ordinaryEnrollment': False}


def readonly_pending(value):
    pending = read(value['directory'] + '/recovery-' + value['recoveryId'] + '.pending.json')
    require(set(pending) == {'schema', 'kind', 'storageSha256', 'fence'} and pending['schema'] == 1
            and pending['kind'] == 'fogd-preview-storage-readonly-intent' and pending['storageSha256'] == value['storageSha256'])
    checked_recovery_fence({**value, 'operation': pending['fence']['record']['operation']}, pending['fence'], 'recover-readonly')
    return pending


def readonly_completion_source(value):
    path = value['directory'] + '/recovery-' + value['recoveryId'] + '.complete.json'
    return record_source(path)


def readonly_completion(value):
    prefix = value['directory'] + '/recovery-' + value['recoveryId']
    if not os.path.lexists(prefix + '.repair.json'):
        return read(prefix + '.complete.json')
    repair = read(prefix + '.repair.json')
    require(set(repair) == {'schema', 'kind', 'original', 'report'} and type(repair['schema']) is int
            and repair['schema'] == 1 and repair['kind'] == 'fogd-preview-storage-readonly-completion-repair')
    require(repair['original'] == readonly_completion_source(value))
    return repair['report']


def inspect_readonly_view(value, original):
    pending = readonly_pending(value)
    recorded = readonly_completion(value)
    current = readonly_report(value, original, pending)
    require(recorded == current)
    assert_no_recovery_writers(value, current['loop'])
    return current, pending


def inspect_readonly_storage(value):
    with admission_lock():
        value, original = recovery_original(value)
        return inspect_readonly_view(value, original)[0]


def recover_readonly_storage(value):
    with admission_lock() as lock_fd:
        value, original = recovery_original({**value, '_lockFd': lock_fd})
        complete_path = value['directory'] + '/recovery-' + value['recoveryId'] + '.complete.json'
        if os.path.lexists(complete_path):
            report, pending = inspect_readonly_view(value, original)
            release_storage_recovery(pending['fence'])
            return report
        return mount_readonly_storage(value, original, complete_path)


def reconcile_readonly_storage(value):
    with admission_lock():
        value, original = recovery_original(value)
        pending = readonly_pending(value)
        report = readonly_report(value, original, pending)
        assert_no_recovery_writers(value, report['loop'])
        complete_path = value['directory'] + '/recovery-' + value['recoveryId'] + '.complete.json'
        if os.path.lexists(complete_path):
            require(readonly_completion(value) == report)
        else:
            fence = pending['fence']
            require(identity(fence['path']) == fence['identity'] and read(fence['path']) == fence['record'])
            append(complete_path, report)
        release_storage_recovery(pending['fence'])
        return report


def require_damaged_readonly_completion(value):
    try:
        read(value['directory'] + '/recovery-' + value['recoveryId'] + '.complete.json')
    except (ValueError, UnicodeError):
        return
    require(False)  # A canonical JSON record, including a conflicting report, is never superseded.


def repair_readonly_completion(value):
    with admission_lock():
        value, original = recovery_original(value)
        pending = readonly_pending(value)
        report = readonly_report(value, original, pending)
        assert_no_recovery_writers(value, report['loop'])
        source = readonly_completion_source(value)
        require(source['sha256'] == value['completionSha256'])
        repair_path = value['directory'] + '/recovery-' + value['recoveryId'] + '.repair.json'
        if not os.path.lexists(repair_path):
            fence = pending['fence']
            require(identity(fence['path']) == fence['identity'] and read(fence['path']) == fence['record'])
            require_damaged_readonly_completion(value)
            append(repair_path, {'schema': 1, 'kind': 'fogd-preview-storage-readonly-completion-repair',
                                 'original': source, 'report': report})
        require(readonly_completion(value) == report)
        release_storage_recovery(pending['fence'])
        return report


def mount_readonly_storage(value, original, complete_path):
    pending_path = value['directory'] + '/recovery-' + value['recoveryId'] + '.pending.json'
    require(not os.path.lexists(pending_path))
    loop = readonly_loop(value)
    mounted = readonly_mount_rows()
    require(not any(row['target'] == paths(value)[1] or loop and row['maj:min'] == loop['maj:min'] for row in mounted))
    identity(paths(value)[1], True)
    require(not os.listdir(paths(value)[1]))
    verify_recovery_image(value)
    assert_no_recovery_writers(value, loop)
    fence = admission_fence(value, 'recover-readonly')
    pending = {'schema': 1, 'kind': 'fogd-preview-storage-readonly-intent', 'storageSha256': value['storageSha256'], 'fence': fence}
    append(pending_path, pending)  # All later unknown effects retain both records and the global fence.
    if loop is None:
        device = run_locked(value, ['losetup', '--find', '--show', '--read-only', '--nooverlap', paths(value)[0]]).strip()
        loop = readonly_loop(value)
        require(loop is not None and loop['name'] == device and loop['ro'] is True)
    run_locked(value, ['mount', '--types', 'ext4', '--options', 'ro,noload,nosuid,nodev,noexec', loop['name'], paths(value)[1]])
    report = readonly_report(value, original, pending)
    assert_no_recovery_writers(value, loop)
    append(complete_path, report)
    release_storage_recovery(fence)
    return report
