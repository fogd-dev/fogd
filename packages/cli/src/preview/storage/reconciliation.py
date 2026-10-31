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
    path = REGISTRY + '/operation.pending.json'
    receipt_path = REGISTRY + '/reconciled-' + value['operation'] + '.json'
    previous = read(receipt_path) if os.path.lexists(receipt_path) else None
    if os.path.lexists(path):
        fence = {'record': read(path), 'identity': identity(path), 'path': path}
    else:
        require(previous is not None)
        fence = previous['fence']
    require(set(fence) == {'record', 'identity', 'path'} and fence['path'] == path)
    require(set(fence['identity']) == {'device', 'inode'})
    require(all(type(v) is int and v > 0 for v in fence['identity'].values()))
    checked_prepare_fence(value, fence['record'])
    receipt = {'schema': 1, 'kind': 'fogd-preview-storage-reconciliation',
               'operation': value['operation'], 'project': value['project'],
               'engineId': value['engineId'], 'root': value['root'],
               'profileId': policy['id'], 'reservation': complete['admission']['reservation'],
               'manifestSha256': hashlib.sha256(encoded(complete)).hexdigest(), 'fence': fence}
    if previous is None:
        append(receipt_path, receipt)  # Durable acknowledgment precedes fence release.
    else:
        require(previous == receipt)
    if os.path.lexists(path):
        release_admission_fence(fence)
    sync_directory(REGISTRY)
    return complete
