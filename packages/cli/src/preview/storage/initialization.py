"""Reviewed completion of unused admission initialization; never reset a used budget."""

INITIALIZATION_RECEIPT = 'initialization.recovered.json'


def initialization_state(value):
    require(identity(value['root'], True) == value['rootIdentity'] and not os.listdir(value['root']))
    require(value['rootIdentity']['device'] == value['dockerDevice'])
    registry = identity(REGISTRY, True)
    names = sorted(os.listdir(REGISTRY))
    require(set(names) <= {'holds', 'policy.json', 'operation.pending.json', INITIALIZATION_RECEIPT})
    entries = {}
    for name in names:
        path = REGISTRY + '/' + name
        if name == 'holds':
            entries[name] = {'kind': 'directory', 'identity': identity(path, True), 'empty': True}
            require(not os.listdir(path))
        else:
            entries[name] = {'kind': 'file', **record_source(path)}
    require(identity(REGISTRY, True) == registry and sorted(os.listdir(REGISTRY)) == names)
    require(identity(value['root'], True) == value['rootIdentity'] and not os.listdir(value['root']))
    return json.loads(encoded({'schema': 1, 'kind': 'fogd-preview-storage-initialization-state',
                               'engineId': value['engineId'], 'root': value['root'], 'rootIdentity': value['rootIdentity'],
                               'registryIdentity': registry, 'entries': entries, 'rootEmpty': True,
                               'resourcesRetained': True, 'executionAuthorized': False}))


def initialization_sha256(snapshot):
    return hashlib.sha256((json.dumps(snapshot, ensure_ascii=False, sort_keys=True, indent=2) + '\n').encode()).hexdigest()


def inspect_initialization(value):
    with admission_lock():
        return initialization_state(value)


def initialization_fence(value, snapshot):
    path = REGISTRY + '/operation.pending.json'
    if 'operation.pending.json' not in snapshot['entries']:
        return admission_fence(value, 'initialize')
    fence = {'path': path, 'identity': snapshot['entries']['operation.pending.json']['identity'], 'record': read(path)}
    require({'kind': 'file', **record_source(path)} == snapshot['entries']['operation.pending.json'])
    checked_recovery_fence({**value, 'project': None, 'operation': fence['record']['operation']}, fence, 'initialize')
    return fence


def finish_initialization_files(value, policy):
    path = REGISTRY + '/holds'
    if not os.path.lexists(path):
        os.mkdir(path, 0o700)
        sync_directory(REGISTRY)
    identity(path, True)
    require(not os.listdir(path))
    if not os.path.lexists(REGISTRY + '/policy.json'):
        append(REGISTRY + '/policy.json', policy)
    require(read_policy(value) == policy)
    check_storage_capacity(policy, 0, backing_space(value))


def finish_initialization_recovery(value, receipt):
    require(set(receipt) == {'schema', 'kind', 'original', 'policy', 'policySource', 'holdsIdentity', 'fence'})
    require(type(receipt['schema']) is int and receipt['schema'] == 1
            and receipt['kind'] == 'fogd-preview-storage-initialization-recovery')
    original = receipt['original']
    require(initialization_sha256(original) == value['registrySha256'])
    current = initialization_state(value)
    require({key: original[key] for key in ['schema', 'kind', 'engineId', 'root', 'rootIdentity', 'registryIdentity', 'rootEmpty']}
            == {key: current[key] for key in ['schema', 'kind', 'engineId', 'root', 'rootIdentity', 'registryIdentity', 'rootEmpty']})
    policy = read_policy(value)
    require(policy == receipt['policy'] and policy['maxProjects'] == value['maxProjects'])
    require(record_source(REGISTRY + '/policy.json') == receipt['policySource']
            and identity(REGISTRY + '/holds', True) == receipt['holdsIdentity'])
    for name in ['policy.json', 'holds']:
        if name in original['entries']:
            require(current['entries'][name] == original['entries'][name])
    fence = receipt['fence']
    checked_recovery_fence({**value, 'project': None, 'operation': fence['record']['operation']}, fence, 'initialize')
    check_storage_capacity(policy, 0, backing_space(value))
    sync_directory(os.path.dirname(REGISTRY))
    release_storage_recovery(fence)
    return admission_status(value)


def recover_initialization(value):
    with admission_lock():
        require(type(value['maxProjects']) is int and 1 <= value['maxProjects'] <= 16)
        snapshot = initialization_state(value)
        receipt_path = REGISTRY + '/' + INITIALIZATION_RECEIPT
        if os.path.lexists(receipt_path):
            return finish_initialization_recovery(value, read(receipt_path))
        require(initialization_sha256(snapshot) == value['registrySha256'])
        policy = read_policy(value) if 'policy.json' in snapshot['entries'] else policy_for(value, value['maxProjects'])
        require(policy['maxProjects'] == value['maxProjects'])
        check_storage_capacity(policy, 0, backing_space(value))
        fence = initialization_fence(value, snapshot)
        finish_initialization_files(value, policy)
        receipt = {'schema': 1, 'kind': 'fogd-preview-storage-initialization-recovery',
                   'original': snapshot, 'policy': policy, 'policySource': record_source(REGISTRY + '/policy.json'),
                   'holdsIdentity': identity(REGISTRY + '/holds', True), 'fence': fence}
        append(receipt_path, receipt)
        return finish_initialization_recovery(value, receipt)
