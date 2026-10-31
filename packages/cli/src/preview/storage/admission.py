"""Engine-wide retained storage accounting and exclusive provisioning fence."""
import uuid
import fcntl
from contextlib import contextmanager

REGISTRY = '/var/lib/fogd-preview-storage-admission'
HEADROOM_BYTES = 1024 ** 3
CHARGE_BYTES = 1024 ** 3 + 16 * 1024 ** 2
HEADROOM_INODES = 8192


class StorageRefusal(Exception):
    def __init__(self, reason):
        self.reason = reason
        super().__init__('storage refused')


def admission_refuse(reason):
    raise StorageRefusal(reason)


def policy_for(value, maximum, profile_id=None):
    require(type(maximum) is int and 1 <= maximum <= 16)
    require(value['rootIdentity']['device'] == value['dockerDevice'])
    require(os.statvfs(value['root']).f_frsize == 4096)
    return {'schema': 1, 'kind': 'fogd-preview-storage-admission', 'id': profile_id or str(uuid.uuid4()),
            'root': value['root'], 'rootIdentity': value['rootIdentity'],
            'engineId': value['engineId'], 'maxProjects': maximum,
            'chargeBytes': CHARGE_BYTES, 'headroomBytes': HEADROOM_BYTES,
            'headroomInodes': HEADROOM_INODES}


def read_policy(value):
    identity(REGISTRY, True)
    policy = read(REGISTRY + '/policy.json')
    require(set(policy) == {'schema', 'kind', 'id', 'root', 'rootIdentity', 'engineId',
                            'maxProjects', 'chargeBytes', 'headroomBytes', 'headroomInodes'})
    require(policy['schema'] == 1 and policy['kind'] == 'fogd-preview-storage-admission')
    require(str(uuid.UUID(policy['id'])) == policy['id'])
    expected = policy_for(value, policy['maxProjects'], policy['id'])
    require(policy == expected)
    return policy


def admission_fence(value, action):
    path = REGISTRY + '/operation.pending.json'
    record = {'schema': 1, 'operation': str(uuid.uuid4()), 'action': action,
              'project': value.get('project'), 'engineId': value['engineId'], 'root': value['root']}
    try:
        append(path, record)
    except FileExistsError:
        admission_refuse('pending')
    return {'record': record, 'identity': identity(path), 'path': path}


def release_admission_fence(fence):
    require(identity(fence['path']) == fence['identity'] and read(fence['path']) == fence['record'])
    os.unlink(fence['path'])
    sync_directory(REGISTRY)


@contextmanager
def admission_lock():
    expected = identity(REGISTRY, True)
    fd = os.open(REGISTRY, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        require({'device': info.st_dev, 'inode': info.st_ino} == expected)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            admission_refuse('pending')
        require(identity(REGISTRY, True) == expected)
        yield fd
    finally:
        os.close(fd)


def initialize_admission(value, maximum):
    policy = policy_for(value, maximum)
    require(not os.listdir(value['root']))
    check_storage_capacity(policy, 0, backing_space(value))
    os.mkdir(REGISTRY, 0o700)  # A second root/engine cannot create another budget.
    sync_directory(os.path.dirname(REGISTRY))
    with admission_lock():
        fence = admission_fence(value, 'initialize')
        os.mkdir(REGISTRY + '/holds', 0o700)
        sync_directory(REGISTRY)
        append(REGISTRY + '/policy.json', policy)
        admission_status(value)
        release_admission_fence(fence)
        return admission_status(value)


def held_storage(value, policy):
    directory = REGISTRY + '/holds'
    identity(directory, True)
    names = sorted(os.listdir(directory))
    require(len(names) <= policy['maxProjects'])
    result, reservations = [], set()
    for name in names:
        require(re.fullmatch(r'fogd-preview-[a-f0-9]{32}\.json', name))
        row = read(directory + '/' + name)
        require(set(row) == {'schema', 'kind', 'profileId', 'reservation', 'project', 'engineId', 'backingBytes', 'chargeBytes'})
        require(row['schema'] == 1 and row['kind'] == 'fogd-preview-storage-hold'
                and row['profileId'] == policy['id'] and row['engineId'] == value['engineId']
                and row['project'] + '.json' == name and row['backingBytes'] == BYTES
                and row['chargeBytes'] == CHARGE_BYTES)
        require(str(uuid.UUID(row['reservation'])) == row['reservation'] and row['reservation'] not in reservations)
        reservations.add(row['reservation'])
        result.append(row)
    require(names == sorted(os.listdir(directory)))
    projects = {row['project'] for row in result}
    require(set(os.listdir(value['root'])) <= projects)
    return result


def backing_space(value):
    require(identity(value['root'], True) == value['rootIdentity'])
    facts = os.statvfs(value['root'])
    require(facts.f_frsize > 0 and 0 <= facts.f_bavail <= facts.f_blocks and facts.f_favail >= 0)
    return {'availableBytes': facts.f_bavail * facts.f_frsize,
            'availableInodes': facts.f_favail, 'device': value['rootIdentity']['device']}


def has_storage_capacity(policy, count, space, quarantines=()):
    return (count < policy['maxProjects']
            and space['availableBytes'] >= CHARGE_BYTES * (1 + len(quarantines)) + HEADROOM_BYTES
            and space['availableInodes'] >= HEADROOM_INODES + 32 * (1 + len(quarantines)))


def check_storage_capacity(policy, count, space, quarantines=()):
    if not has_storage_capacity(policy, count, space, quarantines):
        admission_refuse('capacity')


def admission_status(value):
    policy = read_policy(value)
    rows, quarantines = storage_inventory(value, policy)
    space = backing_space(value)
    pending = os.path.lexists(REGISTRY + '/operation.pending.json')
    remaining = policy['maxProjects'] - len(rows)
    return {'schema': 2, 'kind': 'fogd-preview-storage-admission-status', 'policy': policy,
            'quarantines': [{key: row[key] for key in ['operation', 'project', 'profileId', 'reservation', 'chargeBytes']} for row in quarantines],
            'quarantinedProjects': len(quarantines),
            'quarantinedChargeBytes': len(quarantines) * CHARGE_BYTES,
            'heldProjects': len(rows), 'heldChargeBytes': len(rows) * CHARGE_BYTES,
            'remainingProjects': remaining, 'pending': pending, 'space': space,
            'admissionOpen': not pending and has_storage_capacity(policy, len(rows), space, quarantines),
            'reservations': rows, 'resourcesRetained': True, 'executionAuthorized': False}


def admission_entry(value):
    policy = read_policy(value)
    row = read(REGISTRY + '/holds/' + value['project'] + '.json')
    rows, quarantines = storage_inventory(value, policy)
    require(row in rows and value['project'] not in {entry['project'] for entry in quarantines})
    pending = REGISTRY + '/operation.pending.json'
    if os.path.lexists(pending):
        fence = read(pending)
        if fence['project'] == value['project']:
            require(value.get('action') in ['prepare', 'reconcile'])
            operation = value.get('_operation') if value['action'] == 'prepare' else value.get('operation')
            checked_prepare_fence({**value, 'operation': operation}, fence)
    require(value['admission'] == {'profileId': policy['id'], 'reservation': row['reservation'], 'chargeBytes': CHARGE_BYTES})


def prepare_admitted(value, provision):
    with admission_lock() as lock_fd:
        return provision_admitted({**value, '_lockFd': lock_fd}, provision)


def provision_admitted(value, provision):
    policy = read_policy(value)
    fence = admission_fence(value, 'prepare')
    effects = False
    success = False
    try:
        rows, quarantines = storage_inventory(value, policy)
        require(value['project'] not in {row['project'] for row in rows})
        require(not os.path.lexists(value['directory']))
        check_storage_capacity(policy, len(rows), backing_space(value), quarantines)
        row = {'schema': 1, 'kind': 'fogd-preview-storage-hold', 'profileId': policy['id'],
               'reservation': str(uuid.uuid4()), 'project': value['project'],
               'engineId': value['engineId'], 'backingBytes': BYTES, 'chargeBytes': CHARGE_BYTES}
        effects = True  # Partial ledger writes are retained and block new work.
        append(REGISTRY + '/holds/' + value['project'] + '.json', row)
        admitted = {**value, '_operation': fence['record']['operation'], 'schema': 2, 'admission': {'profileId': policy['id'],
                    'reservation': row['reservation'], 'chargeBytes': CHARGE_BYTES}}
        result = provision(admitted)
        after = backing_space(value)
        require(after['availableBytes'] >= HEADROOM_BYTES + len(quarantines) * CHARGE_BYTES
                and after['availableInodes'] >= HEADROOM_INODES + len(quarantines) * 32)
        success = True
        return result
    finally:
        if success or not effects:
            release_admission_fence(fence)
