"""Run with Python 3 on the owned Linux host; no loop or mount effects."""
import json
import os
import pathlib
import sys
import tempfile
import subprocess
import time
import select
from unittest.mock import patch
from contextlib import contextmanager
import unittest

if sys.argv[1:] == ['--local-source']:
    source = pathlib.Path(__file__).resolve().parents[1] / 'src/preview/storage'
    payload = {name: (source / (name + '.py')).read_text() for name in ['admission', 'commands', 'reconciliation', 'hold-repair', 'recovery-writers', 'readonly-recovery', 'initialization', 'host']}
elif len(sys.argv) == 1:
    payload = json.load(sys.stdin)
else:
    raise RuntimeError('Use --local-source or provide the source bundle on stdin')
scope = {'__name__': 'fogd_storage_admission_test'}
exec(compile(payload['admission'] + '\n' + payload['commands'] + '\n' + payload['reconciliation'] + '\n' + payload['hold-repair'] + '\n' + payload['recovery-writers'] + '\n' + payload['readonly-recovery'] + '\n' + payload['initialization'] + '\n' + payload['host'], 'fogd-storage-worker', 'exec'), scope)


class AdmissionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='fogd-admission-test-')
        self.base = pathlib.Path(self.temp.name)
        self.root = self.base / 'storage'
        self.root.mkdir(mode=0o700)
        scope['REGISTRY'] = str(self.base / 'registry')
        self.value = {'root': str(self.root), 'engineId': 'unit-engine',
                      'rootIdentity': scope['identity'](str(self.root), True),
                      'dockerDevice': self.root.stat().st_dev}
        self.policy = scope['initialize_admission'](self.value, 2)['policy']

    def tearDown(self):
        self.temp.cleanup()  # Only this test's metadata; no provisioner is run.

    def project(self, number):
        name = 'fogd-preview-' + format(number, '032x')
        return {**self.value, 'project': name, 'directory': str(self.root / name)}

    def test_record_publication_is_private_canonical_exclusive_and_leaves_no_staging_names(self):
        path = self.base / 'record.json'
        value = {'kind': 'owned-record', 'payload': 'x' * 8192}
        before = set(self.base.iterdir())
        scope['append'](str(path), value)
        self.assertEqual(scope['read'](str(path)), value)
        self.assertEqual(path.stat().st_nlink, 1)
        identity = scope['identity'](str(path))
        with self.assertRaises(FileExistsError):
            scope['append'](str(path), {'replacement': True})
        self.assertEqual(scope['identity'](str(path)), identity)
        self.assertEqual(scope['read'](str(path)), value)
        self.assertEqual(set(self.base.iterdir()), before | {path})

    def test_record_publication_cannot_replace_a_symlink_or_write_through_an_unsafe_parent(self):
        original = self.base / 'original'
        original.write_bytes(b'keep existing bytes'); original.chmod(0o600)
        link = self.base / 'record.json'; link.symlink_to(original)
        with self.assertRaises(FileExistsError):
            scope['append'](str(link), {'replacement': True})
        self.assertTrue(link.is_symlink()); self.assertEqual(original.read_bytes(), b'keep existing bytes')
        directory = self.base / 'unsafe'; directory.mkdir(mode=0o755)
        with self.assertRaises(ValueError):
            scope['append'](str(directory / 'record.json'), {'private': True})
        self.assertEqual(list(directory.iterdir()), [])

    def test_record_publication_refuses_oversized_data_and_missing_anonymous_file_support(self):
        path = self.base / 'record.json'
        with self.assertRaises(ValueError):
            scope['append'](str(path), {'tooLarge': 'x' * 65536})
        original_open = os.open
        def unsupported(path, flags, *args, **kwargs):
            if flags & os.O_TMPFILE == os.O_TMPFILE:
                raise OSError('injected unsupported anonymous file creation')
            return original_open(path, flags, *args, **kwargs)
        with patch.object(os, 'open', unsupported):
            with self.assertRaises(OSError):
                scope['append'](str(path), {'private': True})
        self.assertFalse(path.exists())

    def test_record_sync_errors_keep_unpublished_data_absent_and_published_data_intact(self):
        original_fsync = os.fsync
        for fail_directory in [False, True]:
            with self.subTest(fail_directory=fail_directory):
                path = self.base / ('record-' + str(fail_directory) + '.json')
                value = {'retained': True}
                def failed(fd):
                    if scope['stat'].S_ISDIR(os.fstat(fd).st_mode) == fail_directory:
                        raise OSError('injected sync failure')
                    return original_fsync(fd)
                with patch.object(os, 'fsync', failed):
                    with self.assertRaises(OSError):
                        scope['append'](str(path), value)
                if fail_directory:
                    self.assertEqual(scope['read'](str(path)), value)
                    with self.assertRaises(FileExistsError):
                        scope['append'](str(path), {'replacement': True})
                else:
                    self.assertFalse(path.exists())

    def test_record_publication_interruptions_expose_only_absent_or_complete_records(self):
        child = r"""
import json,os,stat,sys
bundle=json.loads(sys.stdin.readline());scope={'__name__':'owned_record_publication_child'}
exec(compile('\n'.join(bundle['sources']),'fogd-storage-worker','exec'),scope)
phase=bundle['phase'];original_fdopen=os.fdopen;original_fsync=os.fsync;original_link=os.link

def pause():
 print('ready',flush=True);sys.stdin.readline()

class PartialWriter:
 def __enter__(self):return self
 def __exit__(self,*args):pass
 def write(self,data):
  os.write(bundle_fd[0],data[:17]);pause();raise RuntimeError('child unexpectedly resumed')

def fdopen(fd,*args,**kwargs):
 if phase=='partial-write':bundle_fd[0]=fd;return PartialWriter()
 return original_fdopen(fd,*args,**kwargs)

def fsync(fd):
 directory=stat.S_ISDIR(os.fstat(fd).st_mode)
 if phase=='before-file-sync' and not directory:pause()
 if phase=='before-directory-sync' and directory:pause()
 result=original_fsync(fd)
 if phase=='after-directory-sync' and directory:pause()
 return result

def link(*args,**kwargs):
 if phase=='before-publication':pause()
 return original_link(*args,**kwargs)

bundle_fd=[None];os.fdopen=fdopen;os.fsync=fsync;os.link=link
scope['append'](bundle['path'],bundle['value'])
"""
        value = {'kind': 'owned-interruption', 'payload': 'x' * 8192}
        sources = [payload[name] for name in ['admission', 'commands', 'reconciliation', 'hold-repair', 'recovery-writers', 'readonly-recovery', 'initialization', 'host']]
        for phase in ['partial-write', 'before-file-sync', 'before-publication', 'before-directory-sync', 'after-directory-sync']:
            with self.subTest(phase=phase):
                directory = self.base / phase; directory.mkdir(mode=0o700)
                path = directory / 'record.json'
                process = subprocess.Popen([sys.executable, '-c', child], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                try:
                    process.stdin.write(json.dumps({'sources': sources, 'phase': phase, 'path': str(path), 'value': value}) + '\n'); process.stdin.flush()
                    self.assertTrue(select.select([process.stdout], [], [], 10)[0], 'child did not reach its publication boundary')
                    self.assertEqual(process.stdout.readline().strip(), 'ready')
                    process.kill(); self.assertEqual(process.wait(timeout=5), -9)
                    if phase in ['before-directory-sync', 'after-directory-sync']:
                        self.assertEqual(scope['read'](str(path)), value)
                        self.assertEqual(path.stat().st_nlink, 1)
                        with self.assertRaises(FileExistsError):
                            scope['append'](str(path), {'replacement': True})
                    else:
                        self.assertEqual(list(directory.iterdir()), [])
                        scope['append'](str(path), value)
                        self.assertEqual(scope['read'](str(path)), value)
                    self.assertEqual(list(directory.iterdir()), [path])
                finally:
                    if process.poll() is None:process.kill();process.wait(timeout=5)
                    process.stdin.close();process.stdout.close();process.stderr.close()

    def interrupted_initialization(self, stage):
        root = self.base / ('init-' + stage); root.mkdir(mode=0o700)
        value = {**self.value, 'root': str(root), 'rootIdentity': scope['identity'](str(root), True)}
        scope['REGISTRY'] = str(self.base / ('registry-' + stage))
        os.mkdir(scope['REGISTRY'], 0o700)
        if stage != 'registry':
            scope['admission_fence'](value, 'initialize')
        if stage in ['holds', 'policy']:
            os.mkdir(scope['REGISTRY'] + '/holds', 0o700)
        if stage == 'policy':
            scope['append'](scope['REGISTRY'] + '/policy.json', scope['policy_for'](value, 2))
        snapshot = scope['inspect_initialization'](value)
        return {**value, 'maxProjects': 2, 'registrySha256': scope['initialization_sha256'](snapshot)}, snapshot

    def test_initialization_recovery_finishes_each_unused_boundary_without_replacing_original_records(self):
        for stage in ['registry', 'fence', 'holds', 'policy']:
            with self.subTest(stage=stage):
                value, before = self.interrupted_initialization(stage)
                result = scope['recover_initialization'](value)
                self.assertEqual(result['heldProjects'], 0)
                self.assertEqual(result['remainingProjects'], 2)
                self.assertFalse(result['pending']); self.assertTrue(result['admissionOpen'])
                self.assertFalse(result['executionAuthorized'])
                after = scope['inspect_initialization'](value)
                for name in ['policy.json', 'holds']:
                    if name in before['entries']:self.assertEqual(after['entries'][name], before['entries'][name])
                receipt = pathlib.Path(scope['REGISTRY']) / 'initialization.recovered.json'
                receipt_before = (receipt.read_bytes(), receipt.stat().st_ino)
                self.assertEqual(scope['recover_initialization'](value), result)
                self.assertEqual((receipt.read_bytes(), receipt.stat().st_ino), receipt_before)

    def test_initialization_recovery_requires_the_reviewed_snapshot_and_cannot_change_a_published_limit(self):
        value, before = self.interrupted_initialization('policy')
        policy = pathlib.Path(scope['REGISTRY']) / 'policy.json'; original = policy.read_bytes()
        for bad in [{**value, 'registrySha256': 'f' * 64}, {**value, 'maxProjects': 3}]:
            with self.assertRaises(ValueError):scope['recover_initialization'](bad)
            self.assertEqual(scope['inspect_initialization'](value), before)
        self.assertEqual(policy.read_bytes(), original)

    def test_initialization_recovery_refuses_project_data_holds_and_unknown_registry_entries(self):
        for stage, location in [('data', 'root'), ('held', 'holds'), ('unknown', 'registry')]:
            value, _ = self.interrupted_initialization('refuse-' + stage)
            if location == 'root':path = pathlib.Path(value['root']) / 'retained-data'
            elif location == 'holds':
                directory = pathlib.Path(scope['REGISTRY']) / 'holds'; directory.mkdir(mode=0o700)
                path = directory / 'retained-hold.json'
            else:path = pathlib.Path(scope['REGISTRY']) / 'unrecognized.json'
            path.write_bytes(b'keep retained evidence'); path.chmod(0o600)
            with self.assertRaises(ValueError):scope['recover_initialization'](value)
            self.assertEqual(path.read_bytes(), b'keep retained evidence')
            self.assertFalse((pathlib.Path(scope['REGISTRY']) / 'initialization.recovered.json').exists())

    def test_initialization_recovery_refuses_foreign_fences_and_malformed_policies_without_mutation(self):
        for stage in ['foreign', 'damaged']:
            value, _ = self.interrupted_initialization(stage)
            if stage == 'foreign':
                path = pathlib.Path(scope['REGISTRY']) / 'operation.pending.json'
                row = scope['read'](str(path));row['action'] = 'prepare';path.write_bytes(scope['encoded'](row))
            else:
                path = pathlib.Path(scope['REGISTRY']) / 'policy.json';path.touch(mode=0o600);path.write_bytes(b'{')
            before = scope['inspect_initialization'](value); value['registrySha256'] = scope['initialization_sha256'](before)
            with self.assertRaises((ValueError, KeyError)):scope['recover_initialization'](value)
            self.assertEqual(scope['inspect_initialization'](value), before)

    def test_initialization_recovery_requires_exclusive_ownership_and_sufficient_headroom(self):
        value, before = self.interrupted_initialization('fence')
        with scope['admission_lock']():
            with self.assertRaises(scope['StorageRefusal']):scope['recover_initialization'](value)
        with patch.dict(scope, {'backing_space': lambda value: {'availableBytes': 0, 'availableInodes': 0}}):
            with self.assertRaises(scope['StorageRefusal']):scope['recover_initialization'](value)
        self.assertEqual(scope['inspect_initialization'](value), before)

    def test_initialization_recovery_acknowledgment_survives_result_loss_but_never_clears_a_foreign_fence(self):
        value, _ = self.interrupted_initialization('fence')
        def interrupted(fence):raise RuntimeError('injected completion result loss')
        with patch.dict(scope, {'release_admission_fence': interrupted}):
            with self.assertRaises(RuntimeError):scope['recover_initialization'](value)
        result = scope['recover_initialization'](value);self.assertFalse(result['pending'])
        foreign = scope['admission_fence'](self.project(2), 'prepare')
        with self.assertRaises(ValueError):scope['recover_initialization'](value)
        self.assertEqual(scope['read'](foreign['path']), foreign['record'])

    def test_initialization_recovery_syncs_the_registry_parent_before_releasing_its_fence(self):
        value, _ = self.interrupted_initialization('fence')
        sync_directory = scope['sync_directory']
        def failed(path):
            if path == os.path.dirname(scope['REGISTRY']):raise OSError('injected registry parent sync failure')
            return sync_directory(path)
        with patch.dict(scope, {'sync_directory': failed}):
            with self.assertRaises(OSError):scope['recover_initialization'](value)
        self.assertTrue((pathlib.Path(scope['REGISTRY']) / 'initialization.recovered.json').exists())
        self.assertTrue((pathlib.Path(scope['REGISTRY']) / 'operation.pending.json').exists())
        self.assertFalse(scope['recover_initialization'](value)['pending'])

    def test_initialization_recovery_cannot_reset_a_budget_after_its_first_reservation(self):
        value, _ = self.interrupted_initialization('fence')
        scope['recover_initialization'](value)
        project = {**value, 'project': 'fogd-preview-' + 'a' * 32}
        project['directory'] = value['root'] + '/' + project['project']
        scope['prepare_admitted'](project, lambda value: {'metadataFixtureOnly': True})
        before = scope['admission_status'](value)
        with self.assertRaises(ValueError):scope['recover_initialization'](value)
        self.assertEqual(scope['admission_status'](value), before)
        self.assertEqual(before['heldProjects'], 1)

    def test_interrupted_initialization_recovery_before_acknowledgment_needs_a_new_snapshot(self):
        value, _ = self.interrupted_initialization('fence')
        append = scope['append']
        def interrupted(path, record):
            if path.endswith('/initialization.recovered.json'):raise RuntimeError('injected result loss before acknowledgment')
            return append(path, record)
        with patch.dict(scope, {'append': interrupted}):
            with self.assertRaises(RuntimeError):scope['recover_initialization'](value)
        with self.assertRaises(ValueError):scope['recover_initialization'](value)
        value['registrySha256'] = scope['initialization_sha256'](scope['inspect_initialization'](value))
        self.assertFalse(scope['recover_initialization'](value)['pending'])

    def test_byte_and_inode_headroom_boundaries(self):
        space = {'availableBytes': scope['CHARGE_BYTES'] + scope['HEADROOM_BYTES'],
                 'availableInodes': scope['HEADROOM_INODES'] + 32}
        scope['check_storage_capacity'](self.policy, 0, space)
        for field in ['availableBytes', 'availableInodes']:
            bad = {**space, field: space[field] - 1}
            with self.assertRaises(scope['StorageRefusal']) as failure:
                scope['check_storage_capacity'](self.policy, 0, bad)
            self.assertEqual(failure.exception.reason, 'capacity')

    def test_retained_holds_close_capacity_even_with_free_space(self):
        for number in [1, 2]:
            scope['prepare_admitted'](self.project(number), lambda value: {'testOnly': True})
        observed = scope['admission_status'](self.value)
        self.assertEqual(observed['heldProjects'], 2)
        self.assertEqual(observed['heldChargeBytes'], 2 * scope['CHARGE_BYTES'])
        self.assertFalse(observed['admissionOpen'])
        self.assertFalse(observed['pending'])
        called = []
        with self.assertRaises(scope['StorageRefusal']):
            scope['prepare_admitted'](self.project(3), lambda value: called.append(value))
        self.assertEqual(called, [])
        self.assertFalse((self.base / 'registry/operation.pending.json').exists())

    def test_unknown_provisioning_result_keeps_charge_and_fence(self):
        def interrupted(value):
            raise RuntimeError('injected owned test failure before real provisioning')
        with self.assertRaises(RuntimeError):
            scope['prepare_admitted'](self.project(1), interrupted)
        observed = scope['admission_status'](self.value)
        self.assertEqual(observed['heldProjects'], 1)
        self.assertTrue(observed['pending'])
        self.assertFalse(observed['admissionOpen'])
        with self.assertRaises(scope['StorageRefusal']) as failure:
            scope['prepare_admitted'](self.project(2), lambda value: self.fail('must not provision'))
        self.assertEqual(failure.exception.reason, 'pending')
        self.assertEqual(scope['admission_status'](self.value)['heldProjects'], 1)

    def test_lost_inode_headroom_after_effects_keeps_the_hold_and_fence(self):
        original = scope['backing_space']
        snapshots = iter([{'availableBytes': 4 * scope['BYTES'], 'availableInodes': 10000},
                          {'availableBytes': 4 * scope['BYTES'], 'availableInodes': 8191}])
        scope['backing_space'] = lambda value: next(snapshots)
        try:
            with self.assertRaises(ValueError):
                scope['prepare_admitted'](self.project(1), lambda value: {'testOnly': True})
        finally:
            scope['backing_space'] = original
        observed = scope['admission_status'](self.value)
        self.assertEqual(observed['heldProjects'], 1)
        self.assertTrue(observed['pending'])

    def test_only_the_owner_can_release_a_known_checking_fence(self):
        fence = scope['admission_fence'](self.value, 'test')
        with self.assertRaises(scope['StorageRefusal']):
            scope['admission_fence'](self.value, 'another-test')
        forged = {**fence, 'record': {**fence['record'], 'operation': 'foreign'}}
        with self.assertRaises(ValueError):
            scope['release_admission_fence'](forged)
        self.assertTrue(pathlib.Path(fence['path']).exists())
        scope['release_admission_fence'](fence)
        self.assertFalse(pathlib.Path(fence['path']).exists())

    def test_another_root_cannot_reuse_the_engine_budget(self):
        other = self.base / 'other'
        other.mkdir(mode=0o700)
        value = {**self.value, 'root': str(other), 'rootIdentity': scope['identity'](str(other), True)}
        with self.assertRaises(ValueError):
            scope['read_policy'](value)

    def test_unregistered_storage_is_not_assumed_free(self):
        (self.root / 'unregistered').mkdir(mode=0o700)
        with self.assertRaises(ValueError):
            scope['admission_status'](self.value)

    def test_another_backing_device_cannot_enroll(self):
        with self.assertRaises(ValueError):
            scope['policy_for']({**self.value, 'dockerDevice': self.value['dockerDevice'] + 1}, 2)

    def test_missing_or_changed_policy_is_not_rebuilt(self):
        path = self.base / 'registry/policy.json'
        original = path.read_bytes()
        value = json.loads(original)
        value['engineId'] = 'foreign-engine'
        path.write_bytes(scope['encoded'](value))
        with self.assertRaises(ValueError):
            scope['admission_status'](self.value)
        self.assertNotEqual(path.read_bytes(), original)


    def interrupted_complete(self):
        complete = {}
        def lost_acknowledgment(value):
            complete.update({'schema': 2, 'admission': value['admission'], 'testOnly': True})
            raise RuntimeError('injected result loss after owned metadata fixture')
        with self.assertRaises(RuntimeError):
            scope['prepare_admitted'](self.project(1), lost_acknowledgment)
        fence = scope['read'](scope['REGISTRY'] + '/operation.pending.json')
        return {**self.project(1), 'operation': fence['operation']}, complete

    def test_completed_reconciliation_preserves_charge_and_is_repeatable(self):
        value, complete = self.interrupted_complete()
        before = scope['admission_status'](self.value)
        with patch.dict(scope, {'inspect': lambda request: complete}):
            self.assertEqual(scope['reconcile_storage'](value), complete)
            receipt = pathlib.Path(scope['REGISTRY'] + '/reconciled-' + value['operation'] + '.json')
            original = receipt.read_bytes()
            self.assertEqual(scope['reconcile_storage'](value), complete)
            self.assertEqual(receipt.read_bytes(), original)
        after = scope['admission_status'](self.value)
        self.assertFalse(after['pending'])
        self.assertTrue(after['admissionOpen'])
        self.assertEqual(before['reservations'], after['reservations'])
        self.assertEqual(before['heldChargeBytes'], after['heldChargeBytes'])
        scope['prepare_admitted'](self.project(2), lambda request: {'testOnly': True})
        self.assertFalse(scope['admission_status'](self.value)['admissionOpen'])

    def test_wrong_operation_or_project_cannot_clear_a_fence(self):
        value, complete = self.interrupted_complete()
        before = pathlib.Path(scope['REGISTRY'] + '/operation.pending.json').read_bytes()
        with patch.dict(scope, {'inspect': lambda request: complete}):
            for wrong in [{**value, 'operation': str(scope['uuid'].uuid4())},
                          {**value, 'project': self.project(2)['project']}]:
                with self.assertRaises(ValueError):
                    scope['reconcile_storage'](wrong)
        self.assertEqual(pathlib.Path(scope['REGISTRY'] + '/operation.pending.json').read_bytes(), before)
        self.assertEqual(list((self.base / 'registry').glob('reconciled-*')), [])

    def test_incomplete_or_changed_storage_remains_fenced(self):
        value, complete = self.interrupted_complete()
        with self.assertRaises(FileNotFoundError):
            scope['reconcile_storage'](value)  # Real inspect cannot find completion.
        self.assertTrue(scope['admission_status'](self.value)['pending'])
        with patch.dict(scope, {'inspect': lambda request: complete}):
            scope['reconcile_storage'](value)
            complete['testOnly'] = 'changed'
            with self.assertRaises(ValueError):
                scope['reconcile_storage'](value)
        self.assertEqual(scope['admission_status'](self.value)['heldProjects'], 1)

    def test_interrupted_reconciliation_finishes_its_durable_acknowledgment(self):
        value, complete = self.interrupted_complete()
        def lost_release(fence):
            raise RuntimeError('injected failure after acknowledgment, before fence release')
        with patch.dict(scope, {'inspect': lambda request: complete, 'release_admission_fence': lost_release}):
            with self.assertRaises(RuntimeError):
                scope['reconcile_storage'](value)
        self.assertTrue(scope['admission_status'](self.value)['pending'])
        with patch.dict(scope, {'inspect': lambda request: complete}):
            scope['reconcile_storage'](value)
        self.assertFalse(scope['admission_status'](self.value)['pending'])

    def test_previous_acknowledgment_never_clears_a_new_operation(self):
        value, complete = self.interrupted_complete()
        with patch.dict(scope, {'inspect': lambda request: complete}):
            scope['reconcile_storage'](value)
            foreign = scope['admission_fence'](self.project(2), 'prepare')
            with self.assertRaises(ValueError):
                scope['reconcile_storage'](value)
            self.assertEqual(scope['read'](foreign['path']), foreign['record'])

    def test_corrupt_acknowledgment_and_low_headroom_preserve_fence(self):
        value, complete = self.interrupted_complete()
        low = {'availableBytes': scope['HEADROOM_BYTES'] - 1, 'availableInodes': 10000}
        with patch.dict(scope, {'inspect': lambda request: complete, 'backing_space': lambda request: low}):
            with self.assertRaises(ValueError):
                scope['reconcile_storage'](value)
        receipt = pathlib.Path(scope['REGISTRY'] + '/reconciled-' + value['operation'] + '.json')
        self.assertFalse(receipt.exists())
        scope['append'](str(receipt), {'foreign': True})
        with patch.dict(scope, {'inspect': lambda request: complete}):
            with self.assertRaises(ValueError):
                scope['reconcile_storage'](value)
        self.assertTrue(scope['admission_status'](self.value)['pending'])

    @contextmanager
    def live_registry_owner(self):
        script = "import fcntl,os,sys;fd=os.open(sys.argv[1],os.O_RDONLY|os.O_DIRECTORY);fcntl.flock(fd,fcntl.LOCK_EX);print('ready',flush=True);sys.stdin.readline()"
        child = subprocess.Popen([sys.executable, '-c', script, scope['REGISTRY']],
                                 stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
        try:
            self.assertEqual(child.stdout.readline(), 'ready\n')
            yield
        finally:
            child.communicate('release\n', timeout=10)
        self.assertEqual(child.returncode, 0)

    def test_live_process_excludes_reconciliation(self):
        value, complete = self.interrupted_complete()
        with self.live_registry_owner():
            with self.assertRaises(scope['StorageRefusal']) as failure:
                scope['reconcile_storage'](value)
            self.assertEqual(failure.exception.reason, 'pending')
        with patch.dict(scope, {'inspect': lambda request: complete}):
            scope['reconcile_storage'](value)
        self.assertFalse(scope['admission_status'](self.value)['pending'])

    def test_live_process_excludes_provisioning_before_any_durable_fence(self):
        with self.live_registry_owner():
            with self.assertRaises(scope['StorageRefusal']) as failure:
                scope['prepare_admitted'](self.project(1), lambda request: self.fail('busy'))
            self.assertEqual(failure.exception.reason, 'pending')
            observed = scope['admission_status'](self.value)
            self.assertFalse(observed['pending'])
            self.assertEqual(observed['heldProjects'], 0)
        scope['prepare_admitted'](self.project(1), lambda request: {'testOnly': True})
        self.assertEqual(scope['admission_status'](self.value)['heldProjects'], 1)


    def test_pending_storage_is_not_available_for_execution_before_reconciliation(self):
        value, complete = self.interrupted_complete()
        target = {**value, 'action': 'inspect', 'admission': complete['admission']}
        with self.assertRaises(ValueError):
            scope['admission_entry'](target)
        scope['admission_entry']({**target, 'action': 'reconcile'})
        with self.assertRaises(ValueError):
            scope['admission_entry']({**target, 'action': 'reconcile', 'operation': str(scope['uuid'].uuid4())})
        with patch.dict(scope, {'inspect': lambda request: complete}):
            scope['reconcile_storage'](value)
        scope['admission_entry'](target)

    def test_quarantine_retains_partial_data_charge_and_denies_reuse(self):
        value, _ = self.interrupted_complete()
        directory = pathlib.Path(value['directory'])
        directory.mkdir(mode=0o700)
        data = directory / 'partial-owned-data'
        data.write_bytes(b'retain incomplete provisioning bytes')
        before = scope['admission_status'](self.value)
        after = scope['quarantine_storage'](value)
        self.assertFalse(after['pending'])
        self.assertEqual(after['heldChargeBytes'], before['heldChargeBytes'])
        self.assertEqual(after['quarantinedProjects'], 1)
        self.assertEqual(after['quarantinedChargeBytes'], scope['CHARGE_BYTES'])
        self.assertEqual(data.read_bytes(), b'retain incomplete provisioning bytes')
        self.assertEqual(scope['quarantine_storage'](value), after)
        with self.assertRaises(ValueError):
            scope['prepare_admitted'](self.project(1), lambda request: self.fail('quarantined'))
        admission = {'profileId': self.policy['id'], 'reservation': after['reservations'][0]['reservation'], 'chargeBytes': scope['CHARGE_BYTES']}
        with self.assertRaises(ValueError):
            scope['admission_entry']({**value, 'admission': admission})

    def test_quarantine_reserves_possible_late_allocation_and_inodes(self):
        value, _ = self.interrupted_complete()
        scope['quarantine_storage'](value)
        enough = {'availableBytes': scope['HEADROOM_BYTES'] + 2 * scope['CHARGE_BYTES'],
                  'availableInodes': scope['HEADROOM_INODES'] + 64, 'device': self.value['dockerDevice']}
        for field in ['availableBytes', 'availableInodes']:
            low = {**enough, field: enough[field] - 1}
            with patch.dict(scope, {'backing_space': lambda request: low}):
                self.assertFalse(scope['admission_status'](self.value)['admissionOpen'])
                with self.assertRaises(scope['StorageRefusal']) as failure:
                    scope['prepare_admitted'](self.project(2), lambda request: self.fail('capacity'))
                self.assertEqual(failure.exception.reason, 'capacity')
        with patch.dict(scope, {'backing_space': lambda request: enough}):
            self.assertTrue(scope['admission_status'](self.value)['admissionOpen'])
            scope['prepare_admitted'](self.project(2), lambda request: {'testOnly': True})
        self.assertEqual(scope['admission_status'](self.value)['heldProjects'], 2)
        self.assertFalse(scope['admission_status'](self.value)['admissionOpen'])

    def test_quarantine_refuses_live_owner_wrong_operation_and_unheld_project(self):
        value, _ = self.interrupted_complete()
        with self.live_registry_owner():
            with self.assertRaises(scope['StorageRefusal']):
                scope['quarantine_storage'](value)
        for wrong in [{**value, 'operation': str(scope['uuid'].uuid4())},
                      {**self.project(2), 'operation': value['operation']}]:
            with self.assertRaises((ValueError, StopIteration)):
                scope['quarantine_storage'](wrong)
        self.assertTrue(scope['admission_status'](self.value)['pending'])
        self.assertEqual(scope['admission_status'](self.value)['quarantinedProjects'], 0)

    def test_interrupted_quarantine_retains_its_record_and_can_finish(self):
        value, _ = self.interrupted_complete()
        def lost_release(fence):
            raise RuntimeError('injected interruption after quarantine record sync')
        with patch.dict(scope, {'release_admission_fence': lost_release}):
            with self.assertRaises(RuntimeError):
                scope['quarantine_storage'](value)
        self.assertTrue(scope['admission_status'](self.value)['pending'])
        self.assertEqual(scope['admission_status'](self.value)['quarantinedProjects'], 1)
        scope['quarantine_storage'](value)
        self.assertFalse(scope['admission_status'](self.value)['pending'])
        foreign = scope['admission_fence'](self.project(2), 'prepare')
        with self.assertRaises(ValueError):
            scope['quarantine_storage'](value)
        self.assertEqual(scope['read'](foreign['path']), foreign['record'])

    def test_corrupt_quarantine_blocks_status_inspection_and_new_provisioning(self):
        value, _ = self.interrupted_complete()
        after = scope['quarantine_storage'](value)
        path = pathlib.Path(scope['REGISTRY'] + '/quarantined-' + value['project'] + '.json')
        record = scope['read'](str(path)); record['reservation'] = str(scope['uuid'].uuid4())
        path.write_bytes(scope['encoded'](record))
        for call in [lambda: scope['admission_status'](self.value),
                     lambda: scope['prepare_admitted'](self.project(2), lambda request: self.fail('corrupt')),
                     lambda: scope['admission_entry']({**value, 'admission': after['quarantines'][0]})]:
            with self.assertRaises(ValueError):
                call()

    def damaged_reservation(self, raw=b'{"schema":'):
        value, _ = self.interrupted_complete()
        path = pathlib.Path(scope['REGISTRY'] + '/holds/' + value['project'] + '.json')
        if raw is None:
            path.unlink()  # Owned metadata fixture, before any real provisioning.
        else:
            path.write_bytes(raw)
        source = scope['hold_source'](value['project'])
        return {**value, 'holdSha256': source['sha256']}, path, source

    def test_damaged_hold_repair_preserves_original_and_adds_a_quarantined_charge(self):
        value, path, original = self.damaged_reservation()
        directory = pathlib.Path(value['directory']); directory.mkdir(mode=0o700)
        data = directory / 'retained-data'; data.write_bytes(b'keep partial project data')
        after = scope['repair_storage_hold'](value)
        self.assertEqual(scope['hold_source'](value['project']), original)
        self.assertEqual(path.read_bytes(), b'{"schema":')
        self.assertEqual(data.read_bytes(), b'keep partial project data')
        self.assertEqual(after['heldProjects'], 1)
        self.assertEqual(after['quarantinedProjects'], 1)
        self.assertEqual(after['heldChargeBytes'], scope['CHARGE_BYTES'])
        self.assertFalse(after['pending'])
        self.assertFalse(after['executionAuthorized'])
        repair = pathlib.Path(scope['REGISTRY'] + '/hold-repair-' + value['project'] + '.json')
        before = repair.read_bytes(); second = scope['repair_storage_hold'](value)
        self.assertEqual(second['reservations'], after['reservations'])
        self.assertEqual(repair.read_bytes(), before)
        with self.assertRaises(ValueError):
            scope['admission_entry']({**value, 'admission': after['quarantines'][0]})
        with self.assertRaises(ValueError):
            scope['prepare_admitted'](self.project(1), lambda request: self.fail('repaired project reused'))
        scope['prepare_admitted'](self.project(2), lambda request: {'testOnly': True})
        self.assertEqual(scope['admission_status'](self.value)['heldProjects'], 2)

    def test_noncanonical_or_wrong_shape_holds_can_be_quarantined_without_normalizing_them(self):
        for raw in [b'[]', b'null', b'{}', b'\xff', b'{"schema":1,"reservation":0}']:
            with self.subTest(raw=raw):
                value, path, original = self.damaged_reservation(raw)
                scope['repair_storage_hold'](value)
                self.assertEqual(path.read_bytes(), raw)
                self.assertEqual(scope['hold_source'](value['project']), original)
                # Each subcase uses a new owned metadata registry and no resources.
                self.tearDown(); self.setUp()

    def test_missing_hold_repair_retains_absence_and_accounts_for_the_new_slot(self):
        value, path, original = self.damaged_reservation(None)
        self.assertIsNone(value['holdSha256'])
        after = scope['repair_storage_hold'](value)
        self.assertFalse(path.exists())
        self.assertEqual(scope['hold_source'](value['project']), original)
        self.assertEqual(after['heldProjects'], 1)
        self.assertEqual(after['quarantinedProjects'], 1)
        self.assertEqual(after['remainingProjects'], 1)

    def test_repair_refuses_changed_fingerprint_operation_and_a_live_owner(self):
        value, path, original = self.damaged_reservation()
        for wrong in [{**value, 'holdSha256': '0' * 64}, {**value, 'operation': str(scope['uuid'].uuid4())}]:
            with self.assertRaises(ValueError):
                scope['repair_storage_hold'](wrong)
        with self.live_registry_owner():
            with self.assertRaises(scope['StorageRefusal']):
                scope['repair_storage_hold'](value)
        self.assertEqual(scope['hold_source'](value['project']), original)
        self.assertEqual(list((self.base / 'registry').glob('hold-repair-*')), [])
        self.assertTrue((self.base / 'registry/operation.pending.json').exists())

    def test_repair_cannot_replace_a_valid_hold_or_exceed_the_project_limit(self):
        value, _ = self.interrupted_complete()
        value['holdSha256'] = scope['hold_source'](value['project'])['sha256']
        with self.assertRaises(ValueError):
            scope['repair_storage_hold'](value)
        self.assertEqual(list((self.base / 'registry').glob('hold-repair-*')), [])
        policy = {**self.policy, 'maxProjects': 1}
        with self.assertRaises(ValueError):
            scope['admission_projects'](self.value, policy, [self.project(2)['project']])

    def test_interrupted_repair_can_finish_without_replacing_the_record(self):
        value, _, _ = self.damaged_reservation()
        def lost_release(fence):
            raise RuntimeError('injected interruption after repair record sync')
        with patch.dict(scope, {'release_admission_fence': lost_release}):
            with self.assertRaises(RuntimeError):
                scope['repair_storage_hold'](value)
        self.assertTrue(scope['admission_status'](self.value)['pending'])
        repair = pathlib.Path(scope['REGISTRY'] + '/hold-repair-' + value['project'] + '.json')
        before = repair.read_bytes()
        scope['repair_storage_hold'](value)
        self.assertEqual(repair.read_bytes(), before)
        self.assertFalse(scope['admission_status'](self.value)['pending'])
        foreign = scope['admission_fence'](self.project(2), 'prepare')
        with self.assertRaises(ValueError):
            scope['repair_storage_hold'](value)
        self.assertEqual(scope['read'](foreign['path']), foreign['record'])

    def test_changed_original_or_partial_repair_blocks_future_work(self):
        value, path, _ = self.damaged_reservation()
        scope['repair_storage_hold'](value)
        path.write_bytes(b'changed after owner acknowledgment')
        with self.assertRaises(ValueError):
            scope['admission_status'](self.value)
        with self.assertRaises(ValueError):
            scope['prepare_admitted'](self.project(2), lambda request: self.fail('changed original'))
        self.assertEqual(path.read_bytes(), b'changed after owner acknowledgment')

    def test_partial_repair_and_unsafe_original_are_never_overwritten(self):
        value, path, original = self.damaged_reservation()
        repair = pathlib.Path(scope['REGISTRY'] + '/hold-repair-' + value['project'] + '.json')
        repair.touch(mode=0o600); repair.write_bytes(b'{"schema":')
        with self.assertRaises(ValueError):
            scope['repair_storage_hold'](value)
        self.assertEqual(repair.read_bytes(), b'{"schema":')
        self.assertEqual(scope['hold_source'](value['project']), original)
        self.assertTrue((self.base / 'registry/operation.pending.json').exists())
        path.chmod(0o644)
        with self.assertRaises(ValueError):
            scope['hold_source'](value['project'])

    def writer_fixture(self):
        value = {**self.project(1), 'uuid': '00000000-0000-4000-8000-000000000001'}
        volume = {'name': 'owned-data', 'driver': 'local', 'options': {'device': value['directory'] + '/mount/controller'}}
        container = {'id': 'a' * 64, 'running': False, 'pid': 0, 'status': 'created', 'restart': 'no',
                     'privileged': False, 'devices': [], 'rules': [], 'mounts': [], 'binds': ['owned-data:/data'], 'specs': []}
        return value, volume, container

    def check_writer_fixture(self, value, volumes, containers):
        with patch.dict(scope, {'recovery_docker_rows': lambda command, format_string, pattern, field: volumes if field == 'name' else containers}):
            scope['assert_no_recovery_writers'](value, {'name': '/dev/loop7'})

    def test_readonly_recovery_keeps_effective_quarantine_separate_from_original_reservation(self):
        value, original = self.interrupted_complete()
        original['admission'] = {**original['admission'], 'reservation': str(scope['uuid'].uuid4())}
        digest = scope['hashlib'].sha256((json.dumps(original, ensure_ascii=False, indent=2) + '\n').encode()).hexdigest()
        target = {**value, 'storageSha256': digest}
        with patch.dict(scope, {'storage_origin': lambda request: (request, original)}):
            with self.assertRaises(ValueError):
                scope['recovery_original'](target)
            admitted = scope['quarantine_storage'](value)
            recovered, _ = scope['recovery_original'](target)
        self.assertEqual(recovered['effectiveAdmission']['reservation'], admitted['reservations'][0]['reservation'])
        self.assertNotEqual(recovered['effectiveAdmission']['reservation'], original['admission']['reservation'])

    def test_readonly_recovery_refuses_target_writers_and_automatic_restarts(self):
        value, volume, container = self.writer_fixture()
        self.check_writer_fixture(value, [volume], [container])
        for changes in [{'running': True, 'pid': 9, 'status': 'running'}, {'running': True, 'pid': 9, 'status': 'paused'}, {'restart': 'always'}]:
            with self.assertRaises(ValueError):
                self.check_writer_fixture(value, [volume], [{**container, **changes}])

    def test_readonly_recovery_allows_an_unrelated_running_peer(self):
        value, volume, container = self.writer_fixture()
        peer = {**container, 'binds': [], 'running': True, 'pid': 9, 'status': 'running'}
        self.check_writer_fixture(value, [volume], [peer])
        for changes in [{'privileged': True}, {'devices': [{'PathOnHost': '/dev/loop7'}]}, {'rules': ['b *:* rwm']}]:
            with self.assertRaises(ValueError):
                self.check_writer_fixture(value, [volume], [{**peer, **changes}])

    def test_readonly_recovery_detects_parent_binds_specs_and_nonlocal_volume_writers(self):
        value, volume, container = self.writer_fixture()
        live = {**container, 'running': True, 'pid': 9, 'status': 'running'}
        for row in [{**live, 'binds': [value['root'] + ':/data']},
                    {**live, 'binds': [], 'specs': [{'Type': 'bind', 'Source': value['directory'] + '/mount'}]},
                    {**live, 'binds': [], 'mounts': [{'Type': 'volume', 'Name': 'owned-data', 'Source': '/var/lib/docker/volumes/owned-data/_data'}]}]:
            with self.assertRaises(ValueError):
                self.check_writer_fixture(value, [volume], [row])
        with self.assertRaises(ValueError):
            self.check_writer_fixture(value, [{**volume, 'driver': 'unknown', 'options': None}], [live])

    def test_readonly_mount_accepts_only_identical_readonly_host_bind_aliases(self):
        value, _, _ = self.writer_fixture()
        loop = {'name': '/dev/loop7', 'maj:min': '7:7'}
        primary = {'target': value['directory'] + '/mount', 'source': loop['name'], 'fstype': 'ext4', 'uuid': value['uuid'],
                   'options': 'ro,nosuid,nodev,noexec,relatime,norecovery', 'fsroot': '/', 'maj:min': '7:7'}
        alias = {**primary, 'target': '/owned-host-bind-alias/mount'}
        facts = type('Facts', (), {'f_frsize': 4096, 'f_blocks': 262144, 'f_files': 65536})()
        with patch.dict(scope, {'identity': lambda path, directory=False: {'device': 7, 'inode': 2}}), patch.object(scope['os'], 'statvfs', return_value=facts):
            self.assertEqual(scope['readonly_mount'](value, loop, [primary, alias]), primary)
            with self.assertRaises(ValueError):
                scope['readonly_mount'](value, loop, [primary, {**alias, 'options': 'rw,nosuid,nodev,noexec,relatime'}])
        with patch.dict(scope, {'identity': lambda path, directory=False: {'device': 7, 'inode': 2 if path == primary['target'] else 3}}), patch.object(scope['os'], 'statvfs', return_value=facts):
            with self.assertRaises(ValueError):
                scope['readonly_mount'](value, loop, [primary, alias])

    def readonly_fixture(self):
        value = {**self.project(1), 'recoveryId': str(scope['uuid'].uuid4()), 'storageSha256': 'a' * 64}
        pathlib.Path(value['directory']).mkdir(mode=0o700)
        pathlib.Path(value['directory'] + '/mount').mkdir(mode=0o700)
        report = {'id': value['recoveryId'], 'readOnly': True, 'executionAuthorized': False, 'loop': {'name': '/dev/loop7'}}
        calls = []
        patches = {'recovery_original': lambda request: (request, {}), 'readonly_loop': lambda request: {'name': '/dev/loop7', 'maj:min': '7:7'},
                   'readonly_mount_rows': lambda: [], 'verify_recovery_image': lambda request: None,
                   'assert_no_recovery_writers': lambda request, loop: None, 'readonly_report': lambda request, original, pending: report,
                   'run_locked': lambda request, args: calls.append(args)}
        return value, report, calls, patches

    def test_completed_readonly_recovery_repeats_without_remounting_or_clearing_a_foreign_fence(self):
        value, report, calls, patches = self.readonly_fixture()
        with patch.dict(scope, patches):
            self.assertEqual(scope['recover_readonly_storage'](value), report)
            self.assertEqual(scope['recover_readonly_storage'](value), report)
            self.assertEqual(len(calls), 1)
            self.assertEqual(calls[0][0], 'mount')
            self.assertFalse((self.base / 'registry/operation.pending.json').exists())
            foreign = scope['admission_fence'](self.project(2), 'prepare')
            with self.assertRaises(ValueError):
                scope['recover_readonly_storage'](value)
            self.assertEqual(scope['read'](foreign['path']), foreign['record'])
            self.assertEqual(len(calls), 1)

    def test_new_readonly_loop_is_verified_before_mounting(self):
        value, report, calls, patches = self.readonly_fixture()
        rows = iter([None, {'name': '/dev/loop8', 'maj:min': '7:8', 'ro': True}])
        patches['readonly_loop'] = lambda request: next(rows)
        report['loop'] = {'name': '/dev/loop8'}
        def execute(request, args):
            calls.append(args); return '/dev/loop8\n' if args[0] == 'losetup' else ''
        patches['run_locked'] = execute
        with patch.dict(scope, patches):
            self.assertEqual(scope['recover_readonly_storage'](value), report)
        self.assertEqual([args[0] for args in calls], ['losetup', 'mount'])
        self.assertIn('--read-only', calls[0])
        self.assertIn('ro,noload,nosuid,nodev,noexec', calls[1])

    def test_new_writable_loop_refuses_without_mounting_or_cleanup(self):
        value, _, calls, patches = self.readonly_fixture()
        rows = iter([None, {'name': '/dev/loop8', 'maj:min': '7:8', 'ro': False}])
        patches['readonly_loop'] = lambda request: next(rows)
        def execute(request, args):
            calls.append(args); return '/dev/loop8\n'
        patches['run_locked'] = execute
        with patch.dict(scope, patches):
            with self.assertRaises(ValueError):
                scope['recover_readonly_storage'](value)
        self.assertEqual([args[0] for args in calls], ['losetup'])
        self.assertTrue((self.base / 'registry/operation.pending.json').exists())

    def test_unknown_readonly_mount_outcome_retains_fence_and_never_replays(self):
        value, _, calls, patches = self.readonly_fixture()
        def unknown(request, args):
            calls.append(args); raise RuntimeError('injected unknown mount result')
        patches['run_locked'] = unknown
        with patch.dict(scope, patches):
            with self.assertRaises(RuntimeError):
                scope['recover_readonly_storage'](value)
            with self.assertRaises(ValueError):
                scope['recover_readonly_storage'](value)
        self.assertEqual(len(calls), 1)
        self.assertTrue((self.base / 'registry/operation.pending.json').exists())
        self.assertFalse(pathlib.Path(value['directory'] + '/recovery-' + value['recoveryId'] + '.complete.json').exists())

    def test_explicit_readonly_reconciliation_acknowledges_verified_view_without_mount_replay(self):
        value, report, calls, patches = self.readonly_fixture()
        def unknown(request, args):
            calls.append(args); raise RuntimeError('injected lost mount result')
        with patch.dict(scope, {**patches, 'run_locked': unknown}):
            with self.assertRaises(RuntimeError):
                scope['recover_readonly_storage'](value)
        with patch.dict(scope, patches):
            self.assertEqual(scope['reconcile_readonly_storage'](value), report)
            self.assertEqual(scope['reconcile_readonly_storage'](value), report)
        self.assertEqual(len(calls), 1)
        self.assertFalse((self.base / 'registry/operation.pending.json').exists())

    def test_explicit_readonly_reconciliation_does_not_acknowledge_a_missing_view(self):
        value, _, calls, patches = self.readonly_fixture()
        def unknown(request, args):
            calls.append(args); raise RuntimeError('injected failed mount')
        with patch.dict(scope, {**patches, 'run_locked': unknown}):
            with self.assertRaises(RuntimeError):
                scope['recover_readonly_storage'](value)
        def absent(request, original, pending):
            raise ValueError('no read-only view exists')
        with patch.dict(scope, {**patches, 'readonly_report': absent}):
            with self.assertRaises(ValueError):
                scope['reconcile_readonly_storage'](value)
        self.assertEqual(len(calls), 1)
        self.assertTrue((self.base / 'registry/operation.pending.json').exists())

    def test_readonly_recovery_refuses_covering_underlying_data_before_mounting(self):
        value, _, calls, patches = self.readonly_fixture()
        pathlib.Path(value['directory'] + '/mount/retain-underlying-data').write_bytes(b'keep')
        with patch.dict(scope, patches):
            with self.assertRaises(ValueError):
                scope['recover_readonly_storage'](value)
        self.assertEqual(calls, [])
        self.assertFalse((self.base / 'registry/operation.pending.json').exists())

    def test_readonly_completion_acknowledgment_survives_lost_fence_release(self):
        value, report, calls, patches = self.readonly_fixture()
        def interrupted(fence):
            raise RuntimeError('injected result loss after recovery completion')
        with patch.dict(scope, {**patches, 'release_admission_fence': interrupted}):
            with self.assertRaises(RuntimeError):
                scope['recover_readonly_storage'](value)
        with patch.dict(scope, patches):
            self.assertEqual(scope['recover_readonly_storage'](value), report)
        self.assertEqual(len(calls), 1)
        self.assertFalse((self.base / 'registry/operation.pending.json').exists())

    def partial_readonly_completion(self):
        value, report, calls, patches = self.readonly_fixture()
        path = pathlib.Path(value['directory'] + '/recovery-' + value['recoveryId'] + '.complete.json')
        append = scope['append']
        def interrupted(target, record):
            if target == str(path):
                path.touch(mode=0o600)
                path.write_bytes(b'{"schema":')
                raise RuntimeError('injected partial completion write')
            append(target, record)
        with patch.dict(scope, {**patches, 'append': interrupted}):
            with self.assertRaises(RuntimeError):
                scope['recover_readonly_storage'](value)
        value['completionSha256'] = scope['hashlib'].sha256(path.read_bytes()).hexdigest()
        return value, report, calls, patches, path

    def test_completion_repair_preserves_partial_bytes_and_supports_all_readonly_operations(self):
        value, report, calls, patches, path = self.partial_readonly_completion()
        before = (path.read_bytes(), path.stat().st_ino)
        with patch.dict(scope, patches):
            with self.assertRaises(ValueError):
                scope['reconcile_readonly_storage'](value)
            for operation in ['repair_readonly_completion', 'repair_readonly_completion', 'inspect_readonly_storage',
                              'recover_readonly_storage', 'reconcile_readonly_storage']:
                self.assertEqual(scope[operation](value), report)
        self.assertEqual((path.read_bytes(), path.stat().st_ino), before)
        self.assertEqual(len(calls), 1)  # Only the original mount, never a repair/reconcile replay.
        self.assertFalse((self.base / 'registry/operation.pending.json').exists())

    def test_completion_repair_requires_reviewed_bytes_and_original_fence(self):
        value, _, _, patches, path = self.partial_readonly_completion()
        repair = pathlib.Path(str(path).replace('.complete.json', '.repair.json'))
        fence = self.base / 'registry/operation.pending.json'
        with patch.dict(scope, patches):
            with self.assertRaises(ValueError):
                scope['repair_readonly_completion']({**value, 'completionSha256': 'b' * 64})
            self.assertFalse(repair.exists())
            fence.unlink()
            foreign = scope['admission_fence'](self.project(2), 'prepare')
            with self.assertRaises(ValueError):
                scope['repair_readonly_completion'](value)
            self.assertEqual(scope['read'](foreign['path']), foreign['record'])
        self.assertFalse(repair.exists())

    def test_completion_repair_refuses_canonical_records_even_when_the_report_conflicts(self):
        value, _, _, patches, path = self.partial_readonly_completion()
        path.write_bytes(scope['encoded']({'conflicting': 'canonical record'}))
        value['completionSha256'] = scope['hashlib'].sha256(path.read_bytes()).hexdigest()
        with patch.dict(scope, patches):
            with self.assertRaises(ValueError):
                scope['repair_readonly_completion'](value)
        self.assertTrue((self.base / 'registry/operation.pending.json').exists())
        self.assertFalse(pathlib.Path(str(path).replace('.complete.json', '.repair.json')).exists())

    def test_completion_repair_refuses_a_missing_view_or_writer_before_publication(self):
        value, _, _, patches, path = self.partial_readonly_completion()
        def refused(*args):
            raise ValueError('injected unsafe view')
        for name in ['readonly_report', 'assert_no_recovery_writers']:
            with patch.dict(scope, {**patches, name: refused}):
                with self.assertRaises(ValueError):
                    scope['repair_readonly_completion'](value)
        self.assertTrue((self.base / 'registry/operation.pending.json').exists())
        self.assertFalse(pathlib.Path(str(path).replace('.complete.json', '.repair.json')).exists())

    def test_completion_repair_rechecks_retained_source_and_refuses_a_new_fence(self):
        value, _, _, patches, path = self.partial_readonly_completion()
        with patch.dict(scope, patches):
            scope['repair_readonly_completion'](value)
            foreign = scope['admission_fence'](self.project(2), 'prepare')
            with self.assertRaises(ValueError):
                scope['repair_readonly_completion'](value)
            self.assertEqual(scope['read'](foreign['path']), foreign['record'])
            path.write_bytes(b'changed retained evidence')
            with self.assertRaises(ValueError):
                scope['inspect_readonly_storage'](value)

    def test_partial_repair_acknowledgment_retains_the_fence_without_mount_replay(self):
        value, _, calls, patches, path = self.partial_readonly_completion()
        repair = pathlib.Path(str(path).replace('.complete.json', '.repair.json'))
        def interrupted(target, record):
            self.assertEqual(target, str(repair))
            repair.touch(mode=0o600)
            repair.write_bytes(b'{')
            raise RuntimeError('injected partial repair acknowledgment')
        with patch.dict(scope, {**patches, 'append': interrupted}):
            with self.assertRaises(RuntimeError):
                scope['repair_readonly_completion'](value)
        with patch.dict(scope, patches):
            for operation in ['repair_readonly_completion', 'recover_readonly_storage', 'reconcile_readonly_storage']:
                with self.assertRaises(ValueError):
                    scope[operation](value)
        self.assertTrue((self.base / 'registry/operation.pending.json').exists())
        self.assertEqual(len(calls), 1)
        self.assertEqual(path.read_bytes(), b'{"schema":')

    def test_completion_repair_acknowledgment_survives_lost_fence_release(self):
        value, report, calls, patches, path = self.partial_readonly_completion()
        def interrupted(fence):
            raise RuntimeError('injected result loss after repair acknowledgment')
        with patch.dict(scope, {**patches, 'release_admission_fence': interrupted}):
            with self.assertRaises(RuntimeError):
                scope['repair_readonly_completion'](value)
        with patch.dict(scope, patches):
            self.assertEqual(scope['repair_readonly_completion'](value), report)
        self.assertFalse((self.base / 'registry/operation.pending.json').exists())
        self.assertEqual(len(calls), 1)

    def test_locked_native_utility_receives_only_the_held_new_file(self):
        path = str(self.base / 'owned-command-file')
        fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            with scope['admission_lock']() as lock_fd:
                scope['run_locked']({'_lockFd': lock_fd}, ['fallocate', '--length', '4096', '/proc/self/fd/' + str(fd)], pass_fds=[fd])
            self.assertEqual(os.fstat(fd).st_size, 4096)
            self.assertEqual(os.stat(path).st_ino, os.fstat(fd).st_ino)
        finally:
            os.close(fd)

    def test_native_helper_supervisor_holds_lock_after_caller_exits(self):
        ready, release = str(self.base / 'helper-ready'), str(self.base / 'helper-release')
        helper = "import os,pathlib,sys,time;os.close(int(sys.argv[3]));pathlib.Path(sys.argv[1]).write_text('ready');deadline=time.monotonic()+15\nwhile not pathlib.Path(sys.argv[2]).exists():\n if time.monotonic()>deadline:raise RuntimeError('test release missing')\n time.sleep(0.01)"
        script = "import json,sys;payload=json.load(sys.stdin);s={'__name__':'owned_test'};exec(chr(10).join(payload['sources']),s);s['REGISTRY']=payload['registry']\nwith s['admission_lock']() as fd:s['run_locked']({'_lockFd':fd},[sys.executable,'-c',payload['helper'],payload['ready'],payload['release'],str(fd)])"
        worker = subprocess.Popen([sys.executable, '-c', script], stdin=subprocess.PIPE,
                                  stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        bundle = {'sources': [payload[name] for name in ['admission', 'commands', 'reconciliation', 'hold-repair', 'recovery-writers', 'readonly-recovery', 'initialization', 'host']],
                  'registry': scope['REGISTRY'], 'helper': helper, 'ready': ready, 'release': release}
        worker.stdin.write(json.dumps(bundle)); worker.stdin.close()
        try:
            deadline = time.monotonic() + 10
            while not os.path.exists(ready):
                if worker.poll() is not None:
                    self.fail('owned helper worker exited before readiness: ' + worker.stderr.read())
                self.assertLess(time.monotonic(), deadline)
                time.sleep(0.01)
            worker.terminate()  # Only this test's Python caller; no deployed process.
            worker.wait(timeout=10)
            self.assertNotEqual(worker.returncode, 0)
            with self.assertRaises(scope['StorageRefusal']) as failure:
                scope['prepare_admitted'](self.project(1), lambda request: self.fail('helper still active'))
            self.assertEqual(failure.exception.reason, 'pending')
        finally:
            pathlib.Path(release).write_text('release owned helper')
            if worker.poll() is None:
                worker.terminate(); worker.wait(timeout=10)
            worker.stdout.close(); worker.stderr.close()
            deadline = time.monotonic() + 10
            while True:
                try:
                    with scope['admission_lock']():
                        break
                except scope['StorageRefusal']:
                    self.assertLess(time.monotonic(), deadline)
                    time.sleep(0.01)
        self.assertEqual(scope['admission_status'](self.value)['heldProjects'], 0)


if sys.platform != 'linux' or os.geteuid() != 0 or sys.flags.optimize:
    raise RuntimeError('Host tests require owned Linux root and enabled assertions')
result = unittest.TextTestRunner(stream=sys.stdout, verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(AdmissionTests))
print(json.dumps({'tests': result.testsRun, 'passed': result.wasSuccessful(), 'failures': len(result.failures), 'errors': len(result.errors)}))
sys.exit(0 if result.wasSuccessful() else 1)
