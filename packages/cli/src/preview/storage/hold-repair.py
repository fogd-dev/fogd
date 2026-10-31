"""Conservative owner repair: preserve the original hold and retain a quarantined charge."""


def hold_source(project):
    path = REGISTRY + '/holds/' + project + '.json'
    if not os.path.lexists(path):
        return {'sha256': None, 'identity': None, 'bytes': 0}
    expected = identity(path)
    data = read_bytes(path)
    require(identity(path) == expected)
    return {'sha256': hashlib.sha256(data).hexdigest(), 'identity': expected, 'bytes': len(data)}


def repaired_hold(value, policy, project):
    receipt = read(REGISTRY + '/hold-repair-' + project + '.json')
    require(set(receipt) == {'schema', 'kind', 'project', 'operation', 'engineId', 'root',
                             'profileId', 'reservation', 'chargeBytes', 'original', 'fence'})
    require(type(receipt['schema']) is int and receipt['schema'] == 1
            and receipt['kind'] == 'fogd-preview-storage-hold-repair'
            and receipt['project'] == project and receipt['engineId'] == policy['engineId']
            and receipt['root'] == policy['root'] and receipt['profileId'] == policy['id']
            and receipt['chargeBytes'] == CHARGE_BYTES)
    require(receipt['original'] == hold_source(project))
    checked_recovery_fence({**value, 'project': project, 'operation': receipt['operation']}, receipt['fence'])
    require(str(uuid.UUID(receipt['operation'])) == receipt['operation'])
    row = {'schema': 1, 'kind': 'fogd-preview-storage-hold', 'profileId': policy['id'],
           'reservation': receipt['reservation'], 'project': project, 'engineId': policy['engineId'],
           'backingBytes': BYTES, 'chargeBytes': CHARGE_BYTES}
    return checked_hold(row, value, policy, project)


def damaged_hold(value, policy):
    path = REGISTRY + '/holds/' + value['project'] + '.json'
    if not os.path.lexists(path):
        return True
    try:
        checked_hold(read(path), value, policy, value['project'])
    except (ValueError, UnicodeError, TypeError, KeyError):
        return True
    return False


def repair_storage_hold(value):
    with admission_lock():
        policy = read_policy(value)
        original = hold_source(value['project'])
        require(original['sha256'] == value['holdSha256'])
        require(not os.path.lexists(REGISTRY + '/quarantined-' + value['project'] + '.json'))
        admission_projects(value, policy, [value['project']])
        receipt_path = REGISTRY + '/hold-repair-' + value['project'] + '.json'
        previous, fence = recovery_records(value, receipt_path)
        if previous is None:
            require(damaged_hold(value, policy))
            receipt = {'schema': 1, 'kind': 'fogd-preview-storage-hold-repair',
                       'project': value['project'], 'operation': value['operation'],
                       'engineId': policy['engineId'], 'root': policy['root'], 'profileId': policy['id'],
                       'reservation': str(uuid.uuid4()), 'chargeBytes': CHARGE_BYTES,
                       'original': original, 'fence': fence}
            append(receipt_path, receipt)  # A partial repair record keeps the engine fenced.
        else:
            require(previous['original'] == original)
            receipt = previous
            require(receipt['fence'] == fence)
        repaired_hold(value, policy, value['project'])
        admission_status(value)  # All peer records must validate before releasing the fence.
        release_storage_recovery(fence)
        return admission_status(value)
