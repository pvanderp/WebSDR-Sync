#!/usr/bin/env python3
"""
websdrsync_host.py — Chrome native messaging host: a TCP relay for rigctld.

A browser cannot open a raw TCP socket; there is no API for it in a page or in
an MV3 extension. This tiny host is the piece that can. Chrome starts it when
the console connects and kills it when the console closes — there is no daemon
to remember to start.

It is deliberately dumb: it opens one TCP connection and shuttles bytes. It
knows nothing about Hamlib, so it works just as well against any line-oriented
TCP rig server.

Wire format (Chrome's native messaging): a 4-byte little-endian length followed
by that many bytes of UTF-8 JSON, in both directions.

Extension -> host
    {"op":"connect","host":"127.0.0.1","port":4532}
    {"op":"send","data":"f\\n"}
    {"op":"disconnect"}
    {"op":"ping"}

Host -> extension
    {"op":"connected","peer":"127.0.0.1:4532"}
    {"op":"data","data":"14074000\\n"}
    {"op":"closed"}                 remote hung up
    {"op":"error","error":"..."}
    {"op":"pong","version":"..."}

Only the extension named in the host manifest's allowed_origins can reach this.
"""

import json
import os
import socket
import struct
import sys
import threading
import traceback

VERSION = "0.2"

LOGFILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "websdrsync_host.log")


def log_note(text):
    """Leave evidence on disk. Chrome discards a native host's stderr, so a
    crash at startup otherwise shows up only as 'Native host has exited'."""
    for path in (LOGFILE, os.path.join("/tmp", "websdrsync_host.log")):
        try:
            with open(path, "a") as fh:
                fh.write(text.rstrip() + "\n")
            return
        except Exception:
            continue

# Refuse to be pointed at the wider internet by anything that gets hold of us.
# rigctld on the LAN is fine; a random public host is not what this is for.
ALLOW_ANY_HOST = False

_sock = None
_sock_lock = threading.Lock()
_out_lock = threading.Lock()
_reader = None
_generation = 0          # bumped on every connect, so a stale reader stays quiet


def send_message(obj):
    """Write one length-prefixed JSON message to Chrome."""
    data = json.dumps(obj, separators=(",", ":")).encode("utf-8")
    with _out_lock:
        try:
            sys.stdout.buffer.write(struct.pack("<I", len(data)))
            sys.stdout.buffer.write(data)
            sys.stdout.buffer.flush()
        except Exception:
            # Chrome went away; nothing useful left to do.
            pass


def read_message():
    """Read one length-prefixed JSON message from Chrome, or None at EOF."""
    head = sys.stdin.buffer.read(4)
    if len(head) < 4:
        return None
    (length,) = struct.unpack("<I", head)
    if length == 0 or length > 4 * 1024 * 1024:
        return None
    body = sys.stdin.buffer.read(length)
    if len(body) < length:
        return None
    try:
        return json.loads(body.decode("utf-8"))
    except Exception:
        return None


def is_private(host):
    if ALLOW_ANY_HOST:
        return True
    try:
        infos = socket.getaddrinfo(host, None)
    except Exception:
        return False
    import ipaddress
    for info in infos:
        try:
            ip = ipaddress.ip_address(info[4][0])
        except ValueError:
            return False
        if not (ip.is_loopback or ip.is_private or ip.is_link_local):
            return False
    return True


def close_socket():
    global _sock
    with _sock_lock:
        s, _sock = _sock, None
    if s is not None:
        try:
            s.shutdown(socket.SHUT_RDWR)
        except Exception:
            pass
        try:
            s.close()
        except Exception:
            pass


def reader_loop(sock, generation):
    """Pump everything the rig server says back up to the extension."""
    try:
        while True:
            chunk = sock.recv(65536)
            if not chunk:
                break
            if generation != _generation:
                return
            send_message({"op": "data", "data": chunk.decode("utf-8", "replace")})
    except Exception as exc:
        if generation == _generation:
            send_message({"op": "error", "error": str(exc)})
    if generation == _generation:
        send_message({"op": "closed"})


def do_connect(msg):
    global _sock, _reader, _generation

    host = str(msg.get("host") or "127.0.0.1")
    try:
        port = int(msg.get("port") or 4532)
    except (TypeError, ValueError):
        send_message({"op": "error", "error": "bad port"})
        return
    if not (0 < port < 65536):
        send_message({"op": "error", "error": "port out of range"})
        return
    if not is_private(host):
        send_message({"op": "error",
                      "error": "refusing to connect to %s — this relay only "
                               "talks to loopback or private-network addresses" % host})
        return

    close_socket()
    _generation += 1
    generation = _generation

    try:
        sock = socket.create_connection((host, port), timeout=5)
    except Exception as exc:
        send_message({"op": "error", "error": "%s:%d — %s" % (host, port, exc)})
        return

    sock.settimeout(None)
    try:
        sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
    except Exception:
        pass

    with _sock_lock:
        _sock = sock
    _reader = threading.Thread(target=reader_loop, args=(sock, generation), daemon=True)
    _reader.start()
    send_message({"op": "connected", "peer": "%s:%d" % (host, port)})


def do_send(msg):
    data = msg.get("data")
    if not isinstance(data, str):
        return
    with _sock_lock:
        sock = _sock
    if sock is None:
        send_message({"op": "error", "error": "not connected"})
        return
    try:
        sock.sendall(data.encode("utf-8"))
    except Exception as exc:
        send_message({"op": "error", "error": str(exc)})
        close_socket()
        send_message({"op": "closed"})


def main():
    global _generation

    if sys.platform == "win32":                     # keep stdio binary-clean
        import msvcrt
        msvcrt.setmode(sys.stdin.fileno(), os.O_BINARY)
        msvcrt.setmode(sys.stdout.fileno(), os.O_BINARY)

    while True:
        msg = read_message()
        if msg is None:
            break                                    # Chrome closed the port
        op = msg.get("op")
        if op == "connect":
            do_connect(msg)
        elif op == "send":
            do_send(msg)
        elif op == "disconnect":
            _generation += 1
            close_socket()
            send_message({"op": "closed"})
        elif op == "ping":
            send_message({"op": "pong", "version": VERSION})

    close_socket()


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        print("websdrsync_host %s" % VERSION)
        print("python     %s" % sys.version.split()[0])
        print("executable %s" % sys.executable)
        print("logfile    %s" % LOGFILE)
        raise SystemExit(0)
    # The very first thing, before anything can fail: proof that the interpreter
    # actually started. If this line is missing from the log after Chrome says
    # "Native host has exited", the process never reached Python at all — the
    # problem is exec, quarantine, or the interpreter, not this script.
    log_note("started %s  python=%s  exe=%s  argv=%s  cwd=%s"
             % (VERSION, sys.version.split()[0], sys.executable,
                sys.argv[1:], os.getcwd()))
    try:
        main()
    except Exception:
        # Anything that reaches here would otherwise be an invisible exit.
        log_note("=== crash ===\n" + traceback.format_exc())
        raise
    log_note("exited cleanly (stdin closed)")
