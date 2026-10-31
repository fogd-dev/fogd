"""Explicit reconciliation of completed provisioning; never replay storage effects."""
import hashlib


def checked_prepare_fence(value, fence):
    require(set(fence) == {'schema', 'operation', 'action', 'project', 'engineId', 'root'})
    require(fence == {'schema': 1, 'operation': value['operation'], 'action': 'prepare',
                      'project': value['project'], 'engineId': value['engineId'], 'root': value['root']})


def reconcile_storage(value):
    with admission_lock():
        return reconcile_completed_storage(value)


def reconcile_completed_storage(value):
    policy = read_policy(value)
    complete = inspect(value)  # Actual file, loop, mount, role and reservation readbacks.
    require(complete['schema'] == 2)
    space = backing_space(value)
    require(space['availableBytes'] >= HEADROOM_BYTES and space['availableInodes'] >= HEADROOM_INODES)
    receipt_path = REGISTRY + '/reconciled-' + value['operation'] + '.json'
    previous, fence = recovery_records(value, receipt_path)
    receipt = {'schema': 1, 'kind': 'fogd-preview-storage-reconciliation',
               'operation': value['operation'], 'project': value['project'],
               'engineId': value['engineId'], 'root': value['root'],
               'profileId': policy['id'], 'reservation': complete['admission']['reservation'],
               'manifestSha256': hashlib.sha256(encoded(complete)).hexdigest(), 'fence': fence}
    finish_storage_recovery(receipt_path, receipt, previous, fence)
    return complete


def recovery_records(value, receipt_path):
    path = REGISTRY + '/operation.pending.json'
    previous = read(receipt_path) if os.path.lexists(receipt_path) else None
    if os.path.lexists(path):
        fence = {'record': read(path), 'identity': identity(path), 'path': path}
    else:
        require(previous is not None)
        fence = previous['fence']
    checked_recovery_fence(value, fence)
    return previous, fence


def checked_recovery_fence(value, fence):
    require(set(fence) == {'record', 'identity', 'path'} and fence['path'] == REGISTRY + '/operation.pending.json')
    require(set(fence['identity']) == {'device', 'inode'})
    require(all(type(v) is int and v > 0 for v in fence['identity'].values()))
    checked_prepare_fence(value, fence['record'])


def finish_storage_recovery(receipt_path, receipt, previous, fence):
    if previous is None:
        append(receipt_path, receipt)  # Durable acknowledgment precedes fence release.
    else:
        require(previous == receipt)
    if os.path.lexists(fence['path']):
        release_admission_fence(fence)
    sync_directory(REGISTRY)


def quarantine_record(policy, row, fence):
    value = {'operation': fence['record']['operation'], 'project': row['project'],
             'engineId': policy['engineId'], 'root': policy['root']}
    require(str(uuid.UUID(value['operation'])) == value['operation'])
    checked_recovery_fence(value, fence)
    return {'schema': 1, 'kind': 'fogd-preview-storage-quarantine',
            **value, 'profileId': policy['id'], 'reservation': row['reservation'],
            'chargeBytes': CHARGE_BYTES, 'fence': fence}


def storage_inventory(value, policy):
    rows = held_storage(value, policy)
    by_project = {row['project']: row for row in rows}
    quarantines = []
    names = sorted(name for name in os.listdir(REGISTRY) if name.startswith('quarantined-'))
    for name in names:
        require(re.fullmatch(r'quarantined-fogd-preview-[a-f0-9]{32}\.json', name))
        receipt = read(REGISTRY + '/' + name)
        require(name == 'quarantined-' + receipt['project'] + '.json')
        row = by_project[receipt['project']]
        require(receipt == quarantine_record(policy, row, receipt['fence']))
        quarantines.append(receipt)
    require(names == sorted(name for name in os.listdir(REGISTRY) if name.startswith('quarantined-')))
    require(len({row['operation'] for row in quarantines}) == len(quarantines))
    return rows, quarantines


def quarantine_storage(value):
    with admission_lock():
        policy = read_policy(value)
        rows, _ = storage_inventory(value, policy)
        row = next(row for row in rows if row['project'] == value['project'])
        receipt_path = REGISTRY + '/quarantined-' + value['project'] + '.json'
        previous, fence = recovery_records(value, receipt_path)
        receipt = quarantine_record(policy, row, fence)
        finish_storage_recovery(receipt_path, receipt, previous, fence)
        return admission_status(value)
