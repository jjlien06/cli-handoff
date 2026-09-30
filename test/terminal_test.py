"""Exercise real PTYs and native-process replacement without invoking model accounts."""
import importlib.util
import json
import os
import pathlib
import pty
import select
import shutil
import subprocess
import tempfile
import termios
import time
import unittest

ROOT = pathlib.Path(__file__).resolve().parent.parent
NODE = shutil.which("node")
CLI = ROOT / "src/cli.ts"
spec = importlib.util.spec_from_file_location("handoff_terminal", ROOT / "src/terminal.py")
terminal = importlib.util.module_from_spec(spec)
spec.loader.exec_module(terminal)


class TerminalTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="handoff-pty-test-")
        self.base = pathlib.Path(self.tmp.name)
        self.cwd = self.base / "project"
        self.cwd.mkdir()
        self.bin = self.base / "bin"
        self.bin.mkdir()
        self.master, self.slave = pty.openpty()
        self.initial = termios.tcgetattr(self.slave)
        self.child = None
        self.output = b""
        self.env = dict(os.environ, HANDOFF_HOME=str(self.base / "home"), HANDOFF_DATA_DIR=str(self.base / "data"), CODEX_HOME=str(self.base / "home/.codex"), PATH=str(self.bin) + os.pathsep + os.environ["PATH"])
        for key in ("HANDOFF_CONTROL_FILE", "HANDOFF_CONTROL_TOKEN", "CODEX_THREAD_ID", "CLAUDE_SESSION_ID", "CLAUDECODE"):
            self.env.pop(key, None)
        self.checkpoint = self.base / "checkpoint.json"
        fields = ("constraints", "decisions", "completed", "active", "next", "questions", "approvals", "artifacts", "running", "tests")
        value = dict(title="Terminal handoff", goal="Continue the terminal task", **{k: [] for k in fields})
        value["constraints"] = ["PTY-SENTINEL-KEEP"]
        self.checkpoint.write_text(json.dumps(value))
        for provider in ("codex", "claude"):
            transcript = self.base / (provider + ".jsonl")
            if provider == "codex":
                rows = [{"type": "session_meta", "payload": {"id": "mock-codex", "cwd": str(self.cwd), "history_mode": "legacy"}}, {"type": "response_item", "payload": {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "PTY-SENTINEL-KEEP"}]}}]
            else:
                rows = [{"type": "user", "sessionId": "mock-claude", "cwd": str(self.cwd), "uuid": "mock-user", "message": {"role": "user", "content": "PTY-SENTINEL-KEEP"}}]
            transcript.write_text("\n".join(json.dumps(r) for r in rows) + "\n")
            # These fixtures act like native terminal applications and invoke the real bridge.
            script = """#!{python}
import json,os,pathlib,subprocess,sys
provider=pathlib.Path(sys.argv[0]).name
if '--version' in sys.argv: print('fixture-cli');sys.exit(0)
node={node!r};cli={cli!r};checkpoint={checkpoint!r};base={base!r}
def command(args):
 r=subprocess.run([node,cli]+args,capture_output=True,text=True,env=os.environ)
 if r.returncode:print('EXPORT_FAILED '+r.stderr.strip(),flush=True);return None
 return r.stdout
print('STARTED_'+provider.upper(),flush=True)
prompt=next((a for a in sys.argv if a.startswith('Use the import-sync skill')),None)
if prompt:
 id=prompt.split('handoff ')[1].split(' ')[0]
 packet=command(['import',id,'--provider',provider,'--json'])
 assert packet and 'PTY-SENTINEL-KEEP' in json.loads(packet)['packet']
 assert command(['ack',id,'--provider',provider,'--session','mock-'+provider])
 print('IMPORTED_'+provider.upper(),flush=True)
while True:
 try: text=input()
 except KeyboardInterrupt:continue
 except EOFError:break
 if text.strip()=='/exit':break
 if text.strip()=='switch':
  result=command(['switch','--provider',provider,'--session','mock-'+provider,'--checkpoint',checkpoint,'--transcript',str(pathlib.Path(base)/(provider+'.jsonl'))])
  if result:print('SAVED_'+provider.upper(),flush=True)
 if text.strip()=='ping':print('ALIVE_'+provider.upper(),flush=True)
print('CLOSED_'+provider.upper(),flush=True)
""".format(python=shutil.which("python3"), node=NODE, cli=str(CLI), checkpoint=str(self.checkpoint), base=str(self.base))
            binary = self.bin / provider
            binary.write_text(script)
            binary.chmod(0o755)

    def tearDown(self):
        if self.child and self.child.poll() is None:
            self.child.terminate()
            try:
                self.child.wait(timeout=8)
            except subprocess.TimeoutExpired:
                self.child.kill()
                self.child.wait()
        os.close(self.master)
        os.close(self.slave)
        self.tmp.cleanup()

    def start(self):
        self.child = subprocess.Popen([NODE, "--disable-warning=ExperimentalWarning", str(CLI), "start", "codex"], cwd=self.cwd, env=self.env, stdin=self.slave, stdout=self.slave, stderr=self.slave)
        self.expect(b"STARTED_CODEX")

    def expect(self, marker, timeout=15):
        deadline = time.monotonic() + timeout
        while marker not in self.output:
            self.assertLess(time.monotonic(), deadline, self.output.decode(errors="replace")[-4000:])
            ready, _, _ = select.select([self.master], [], [], 0.1)
            if ready:
                self.output += os.read(self.master, 65536)

    def assert_terminal_restored(self):
        restored = termios.tcgetattr(self.slave)
        original = self.initial.copy()
        # PENDIN is a kernel-managed pending-input flag set on canonical-mode restoration.
        restored[3] &= ~getattr(termios, 'PENDIN', 0)
        original[3] &= ~getattr(termios, 'PENDIN', 0)
        self.assertEqual(restored, original)

    def send(self, value):
        os.write(self.master, value + b"\r")

    def test_same_terminal_roundtrip_imports_before_continuing_and_restores_tty(self):
        self.start()
        self.send(b"switch")
        self.expect(b"IMPORTED_CLAUDE")
        self.assertLess(self.output.index(b"CLOSED_CODEX"), self.output.index(b"STARTED_CLAUDE"))
        self.output = b""
        self.send(b"switch")
        self.expect(b"IMPORTED_CODEX")
        self.assertLess(self.output.index(b"CLOSED_CLAUDE"), self.output.index(b"STARTED_CODEX"))
        self.send(b"/exit")
        self.expect(b"CLOSED_CODEX")
        self.assertEqual(self.child.wait(timeout=8), 0)
        self.assert_terminal_restored()
        self.assertEqual(list((self.base / "data/controllers").glob("*.json")), [])

    def test_failed_export_keeps_source_open_without_launching_target(self):
        value = json.loads(self.checkpoint.read_text())
        value["goal"] = ""
        self.checkpoint.write_text(json.dumps(value))
        self.start()
        self.send(b"switch")
        self.expect(b"EXPORT_FAILED")
        self.send(b"ping")
        self.expect(b"ALIVE_CODEX")
        self.assertNotIn(b"STARTED_CLAUDE", self.output)
        self.send(b"/exit")
        self.expect(b"CLOSED_CODEX")
        self.assertEqual(self.child.wait(timeout=8), 0)
        self.assert_terminal_restored()

    def test_stale_request_cannot_stop_a_different_source_cli(self):
        controller = dict(version=1, token="fresh", cwd=str(self.cwd), provider="codex")
        request = dict(version=1, token="old", cwd=str(self.cwd), source="codex", target="claude", handoff="01234567-89ab-cdef-0123-456789abcdef")
        with self.assertRaises(ValueError):
            terminal.validate_request(request, controller)


if __name__ == "__main__":
    unittest.main()
