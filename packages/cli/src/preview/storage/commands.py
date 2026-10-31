"""Retain the provisioning lock while native helpers outlive their caller."""

# The supervisor keeps its inherited lock even if the utility closes extra FDs.
# If the caller exits, the supervisor waits for the utility before closing it.
COMMAND_SUPERVISOR = """
import json, subprocess, sys
lock_fd = int(sys.argv[1])
args = json.loads(sys.argv[2])
fds = json.loads(sys.argv[3])
result = subprocess.run(args, pass_fds=fds, timeout=30)
sys.exit(result.returncode)
"""


def run_locked(value, args, pass_fds=()):
    lock_fd = value['_lockFd']
    fds = sorted({lock_fd, *pass_fds})
    return subprocess.run([sys.executable, '-c', COMMAND_SUPERVISOR, str(lock_fd),
                           json.dumps(args), json.dumps(fds)], pass_fds=fds,
                          check=True, capture_output=True, text=True, env=ENV).stdout
