"""Owned Linux-host storage operations. No resize, delete or uncertain replay."""
import json
import os
import re
import stat
import subprocess
import sys

BYTES = 1024 ** 3
ROLES = ['minio', 'slot-1-a', 'slot-1-b', 'slot-2-a', 'slot-2-b', 'controller',
         'controller-trust', 'controller-input', 'gateway-trust', 'gateway-input',
         'ingress-trust', 'ingress-input']
ENV = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LC_ALL': 'C'}


def require(condition):
    if not condition:
        raise ValueError('storage refused')


def run(args):
    return subprocess.run(args, check=True, capture_output=True, text=True,
                          env=ENV, timeout=30).stdout


def identity(path, directory=False):
    info = os.lstat(path)
    require((stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode))
            and stat.S_IMODE(info.st_mode) == (0o700 if directory else 0o600)
            and info.st_uid == 0 and (directory or info.st_nlink == 1))
    return {'device': info.st_dev, 'inode': info.st_ino}


def sync_directory(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def encoded(value):
    return (json.dumps(value, sort_keys=True, separators=(',', ':')) + '\n').encode()


def append(path, value):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, 'wb', closefd=False) as file:
            file.write(encoded(value))
            file.flush()
            os.fsync(fd)
    finally:
        os.close(fd)
    sync_directory(os.path.dirname(path))


def read(path):
    expected = identity(path)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        actual = os.fstat(fd)
        require({'device': actual.st_dev, 'inode': actual.st_ino} == expected)
        with os.fdopen(fd, 'rb', closefd=False) as file:
            data = file.read(65537)
        require(len(data) <= 65536 and identity(path) == expected)
        value = json.loads(data)
        require(data == encoded(value))
        return value
    finally:
        os.close(fd)


def request(value):
    require(isinstance(value, dict) and set(value) == {'action', 'root', 'project', 'engineId'})
    require(value['action'] in ['prepare', 'inspect', 'inspect-empty', 'inspect-installed'])
    require(isinstance(value['root'], str) and re.fullmatch(r'/[A-Za-z0-9_./-]{1,200}', value['root']))
    require(os.path.realpath(value['root']) == value['root'] and os.path.normpath(value['root']) == value['root'])
    require(isinstance(value['project'], str) and re.fullmatch(r'fogd-preview-[a-f0-9]{32}', value['project']))
    require(isinstance(value['engineId'], str) and re.fullmatch(r'[^\x00-\x20\x7f]{1,256}', value['engineId']))
    require(sys.platform == 'linux' and os.geteuid() == 0)
    engine = run(['docker', '--host', 'unix:///var/run/docker.sock', 'info', '--format', '{{.ID}}']).strip()
    require(engine == value['engineId'])
    root = identity(value['root'], True)
    backing = json.loads(run(['findmnt', '--json', '--target', value['root'], '--output', 'FSTYPE']))['filesystems']
    require(len(backing) == 1 and backing[0]['fstype'] == 'ext4')
    project = value['project']
    return {**value, 'rootIdentity': root, 'directory': value['root'] + '/' + project,
            'uuid': '-'.join([project[13:21], project[21:25], project[25:29], project[29:33], project[33:45]])}


def bound(value):
    require(identity(value['root'], True) == value['rootIdentity'])
    identity(value['directory'], True)


def paths(value):
    return value['directory'] + '/disk.img', value['directory'] + '/mount'


def disk_state(value):
    disk, _ = paths(value)
    result = identity(disk)
    info = os.lstat(disk)
    require(info.st_size == BYTES and info.st_blocks * 512 >= BYTES)
    return {**result, 'bytes': info.st_size, 'allocatedBytes': info.st_blocks * 512}


def loop_state(value, device):
    require(isinstance(device, str) and re.fullmatch(r'/dev/loop[0-9]+', device))
    rows = json.loads(run(['losetup', '--json', '--list', '--output',
                          'NAME,BACK-FILE,BACK-INO,BACK-MAJ:MIN,MAJ:MIN,RO,AUTOCLEAR,OFFSET,SIZELIMIT', device]))['loopdevices']
    require(len(rows) == 1)
    row = rows[0]
    info = os.lstat(paths(value)[0])
    require(row['name'] == device and row['back-file'] == paths(value)[0]
            and int(row['back-ino']) == info.st_ino
            and row['back-maj:min'] == f'{os.major(info.st_dev)}:{os.minor(info.st_dev)}'
            and not row['ro'] and not row['autoclear'] and row['offset'] == 0 and row['sizelimit'] == 0)
    return row


def mounted_state(value, device):
    _, mount = paths(value)
    identity(mount, True)
    rows = json.loads(run(['findmnt', '--json', '--mountpoint', mount, '--output',
                          'TARGET,SOURCE,FSTYPE,UUID,OPTIONS,FSROOT,MAJ:MIN']))['filesystems']
    require(len(rows) == 1)
    row = rows[0]
    require(row['target'] == mount and row['source'] == device and row['fstype'] == 'ext4'
            and row['uuid'] == value['uuid'] and row['fsroot'] == '/')
    options = set(row['options'].split(','))
    require({'rw', 'nosuid', 'nodev', 'noexec'} <= options and not {'ro', 'discard'} & options)
    require(row['maj:min'] == loop_state(value, device)['maj:min'])
    facts = os.statvfs(mount)
    require(facts.f_frsize == 4096 and 0 < facts.f_blocks * facts.f_frsize <= BYTES
            and facts.f_files == 65536)
    return row


def marker(value):
    return {'schema': 1, 'kind': 'fogd-preview-storage', 'project': value['project'],
            'engineId': value['engineId'], 'uuid': value['uuid'], 'bytes': BYTES}


def inspect(value):
    bound(value)
    directory = value['directory']
    complete = read(directory + '/storage.complete.json')
    require(set(complete) == {'schema', 'kind', 'project', 'engineId', 'uuid', 'bytes',
                             'rootIdentity', 'directoryIdentity', 'disk', 'loop', 'mount', 'roles'})
    require({key: complete[key] for key in marker(value)} == marker(value))
    require(complete['rootIdentity'] == value['rootIdentity']
            and complete['directoryIdentity'] == identity(directory, True))
    current = disk_state(value)
    require(current['device'] == complete['disk']['device'] and current['inode'] == complete['disk']['inode'])
    require(loop_state(value, complete['loop']['name']) == complete['loop'])
    require(mounted_state(value, complete['loop']['name']) == complete['mount'])
    mount = paths(value)[1]
    require(read(mount + '/.fogd-preview-storage.json') == marker(value))
    require(read(directory + '/storage.pending.json') == marker(value))
    require(read(directory + '/storage.attached.json') == complete['loop'])
    require(read(directory + '/storage.mounted.json') == complete['mount'])
    for phase in ['allocated', 'formatted']:
        step = read(directory + '/storage.' + phase + '.json')
        require(set(step) == {'device', 'inode', 'bytes', 'allocatedBytes'})
        require(step['device'] == current['device'] and step['inode'] == current['inode']
                and step['bytes'] == BYTES and step['allocatedBytes'] >= BYTES)
    require(set(complete['roles']) == set(ROLES))
    for role in ROLES:
        require(identity(mount + '/' + role, True) == complete['roles'][role])
    return complete


def format_disk(value):
    disk, _ = paths(value)
    fd = os.open(disk, os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        target = '/proc/self/fd/' + str(fd)
        subprocess.run(['fallocate', '--length', str(BYTES), target], pass_fds=[fd],
                       check=True, capture_output=True, env=ENV, timeout=30)
        require(disk_state(value)['inode'] == os.fstat(fd).st_ino)
        append(value['directory'] + '/storage.allocated.json', disk_state(value))
        subprocess.run(['mkfs.ext4', '-q', '-F', '-b', '4096', '-m', '0', '-N', '65536',
                        '-U', value['uuid'], '-E', 'nodiscard,lazy_itable_init=0,lazy_journal_init=0', target],
                       pass_fds=[fd], check=True, capture_output=True, env=ENV, timeout=30)
        os.fsync(fd)
        require(disk_state(value)['inode'] == os.fstat(fd).st_ino)
    finally:
        os.close(fd)
    append(value['directory'] + '/storage.formatted.json', disk_state(value))


def prepare(value):
    directory = value['directory']
    bound_root = identity(value['root'], True)
    require(bound_root == value['rootIdentity'])
    os.mkdir(directory, 0o700)  # Exclusive admission; never resume this operation.
    sync_directory(value['root'])
    append(directory + '/storage.pending.json', marker(value))
    format_disk(value)
    bound(value)
    device = run(['losetup', '--find', '--show', '--nooverlap', paths(value)[0]]).strip()
    loop = loop_state(value, device)
    append(directory + '/storage.attached.json', loop)
    mount = paths(value)[1]
    os.mkdir(mount, 0o700)
    run(['mount', '--types', 'ext4', '--options', 'nosuid,nodev,noexec,nodiscard', device, mount])
    os.chmod(mount, 0o700)
    mounted = mounted_state(value, device)
    append(directory + '/storage.mounted.json', mounted)
    append(mount + '/.fogd-preview-storage.json', marker(value))
    roles = {}
    for role in ROLES:
        os.mkdir(mount + '/' + role, 0o700)
        roles[role] = identity(mount + '/' + role, True)
    sync_directory(mount)
    complete = {**marker(value), 'rootIdentity': value['rootIdentity'],
                'directoryIdentity': identity(directory, True), 'disk': disk_state(value),
                'loop': loop, 'mount': mounted, 'roles': roles}
    append(directory + '/storage.complete.json', complete)
    return inspect(value)


def main():
    try:
        data = sys.stdin.buffer.read(4097)
        require(len(data) <= 4096)
        value = request(json.loads(data))
        result = prepare(value) if value['action'] == 'prepare' else inspect(value)
        if value['action'] in ['inspect-empty', 'inspect-installed']:
            roles = ROLES if value['action'] == 'inspect-empty' else ROLES[:6]
            for role in roles:
                require(not os.listdir(paths(value)[1] + '/' + role))
        print(json.dumps({'ok': True, 'storage': result}, separators=(',', ':')))
    except Exception:
        # Raw utility diagnostics may contain host paths. Keep them private.
        print('{"ok":false,"reason":"storage-refused-retain-resources"}')
        sys.exit(1)


if __name__ == '__main__':
    main()
