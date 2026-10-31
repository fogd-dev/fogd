"""Run with Python 3 on the owned Linux host; no loop or mount effects."""
import json
import os
import pathlib
import sys
import tempfile
import unittest

if sys.argv[1:] == ['--local-source']:
    source = pathlib.Path(__file__).resolve().parents[1] / 'src/preview/storage'
    payload = {name: (source / (name + '.py')).read_text() for name in ['admission', 'host']}
elif len(sys.argv) == 1:
    payload = json.load(sys.stdin)
else:
    raise RuntimeError('Use --local-source or provide the source bundle on stdin')
scope = {'__name__': 'fogd_storage_admission_test'}
exec(compile(payload['admission'] + '\n' + payload['host'], 'fogd-storage-worker', 'exec'), scope)


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


if sys.platform != 'linux' or os.geteuid() != 0 or sys.flags.optimize:
    raise RuntimeError('Host tests require owned Linux root and enabled assertions')
result = unittest.TextTestRunner(stream=sys.stdout, verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(AdmissionTests))
print(json.dumps({'tests': result.testsRun, 'passed': result.wasSuccessful(), 'failures': len(result.failures), 'errors': len(result.errors)}))
sys.exit(0 if result.wasSuccessful() else 1)
