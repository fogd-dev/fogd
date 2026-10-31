"""Run with Python 3 on the owned Linux host; no loop or mount effects."""
import json
import os
import pathlib
import sys
import tempfile
import subprocess
import time
from unittest.mock import patch
from contextlib import contextmanager
import unittest

if sys.argv[1:] == ['--local-source']:
    source = pathlib.Path(__file__).resolve().parents[1] / 'src/preview/storage'
    payload = {name: (source / (name + '.py')).read_text() for name in ['admission', 'commands', 'reconciliation', 'hold-repair', 'host']}
elif len(sys.argv) == 1:
    payload = json.load(sys.stdin)
else:
    raise RuntimeError('Use --local-source or provide the source bundle on stdin')
scope = {'__name__': 'fogd_storage_admission_test'}
exec(compile(payload['admission'] + '\n' + payload['commands'] + '\n' + payload['reconciliation'] + '\n' + payload['hold-repair'] + '\n' + payload['host'], 'fogd-storage-worker', 'exec'), scope)


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
        bundle = {'sources': [payload[name] for name in ['admission', 'commands', 'reconciliation', 'hold-repair', 'host']],
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
