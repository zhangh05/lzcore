"""Public-web fetch boundaries, with no network or real DNS access."""

import pytest
import io
import socket
import ssl

from core.tools.general_tools import web_content as web


@pytest.mark.parametrize("scheme,address", [("http", "8.8.8.8"), ("https", "8.8.8.8"),
                                           ("https", "2606:4700:4700::1111")])
@pytest.mark.parametrize("certificate_host", ["public.test", "wrong.test"])
def test_transport_pins_socket_and_preserves_host_sni_and_certificate_check(monkeypatch, scheme, address, certificate_host):
    import urllib3.connection as connection
    destinations, sent, dns_calls, tls = [], [], [], []
    sockets = []

    def dns(host, port, **kwargs):
        dns_calls.append(host)
        # A second resolution would return loopback after successful preflight.
        answer = address if len(dns_calls) == 1 else "127.0.0.1"
        return [(socket.AF_INET6 if ":" in answer else socket.AF_INET, socket.SOCK_STREAM, 6, "", (answer, 0))]

    class Socket:
        def __init__(self, *args):
            self.family = args[0]
            self.closed = False
            sockets.append(self)
        def settimeout(self, value):
            pass
        def setsockopt(self, *args):
            pass
        def connect(self, destination):
            destinations.append(destination)
        def sendall(self, data):
            sent.append(bytes(data))
        def makefile(self, *args):
            body = b"<html><p>Pinned evidence</p></html>"
            return io.BytesIO(b"HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: "
                              + str(len(body)).encode() + b"\r\nConnection: close\r\n\r\n" + body)
        def getpeercert(self, **kwargs):
            return {"subjectAltName": (("DNS", certificate_host),)}
        def getpeername(self):
            return (address, 8443)
        def close(self):
            self.closed = True

    def wrap(**kwargs):
        tls.append(kwargs["server_hostname"])
        assert kwargs["ssl_context"].verify_mode == ssl.CERT_REQUIRED
        return kwargs["sock"]

    monkeypatch.setattr(web, "_fetch_cache", {})
    monkeypatch.setattr(web.requests.utils, "get_environ_proxies", lambda url: {})
    monkeypatch.setattr(socket, "getaddrinfo", dns)
    monkeypatch.setattr(socket, "socket", Socket)
    monkeypatch.setattr(connection, "ssl_wrap_socket", wrap)
    result = web.fetch_and_extract(f"{scheme}://public.test:8443/evidence")
    assert dns_calls == ["public.test"]
    assert destinations == [(address, 8443)]
    assert sockets[0].family == (socket.AF_INET6 if ":" in address else socket.AF_INET)
    assert all(s.closed for s in sockets)
    if scheme == "https":
        assert tls == ["public.test"]
    if scheme == "https" and certificate_host != "public.test":
        assert not result["ok"] and not sent
    else:
        assert result["ok"] and "Pinned evidence" in result["content"]
        assert b"Host: public.test:8443\r\n" in b"".join(sent)


def test_environment_proxy_is_rejected_before_socket_connect(monkeypatch):
    monkeypatch.setattr(web.requests.utils, "get_environ_proxies", lambda url: {"https": "http://proxy.test:8080"})
    monkeypatch.setattr(web, "_pinned_adapter", lambda *a: pytest.fail("proxy transport opened"))
    with pytest.raises(ValueError, match="environment proxy"):
        web._open_pinned_response("https://public.test/", {"8.8.8.8"}, 1)


def test_legacy_and_current_adapter_entries_use_the_same_pinned_pool():
    adapter = web._pinned_adapter("https://public.test/", "8.8.8.8")
    try:
        request = web.requests.Request("GET", "https://public.test/").prepare()
        assert adapter.get_connection(request.url) is adapter.get_connection_with_tls_context(request, True)
        with pytest.raises(ValueError, match="origin mismatch"):
            adapter.get_connection("https://other.test/")
        with pytest.raises(ValueError, match="verified transport"):
            adapter.send(request, verify=False)
    finally:
        adapter.close()


def test_no_proxy_allows_only_direct_pinned_transport(monkeypatch):
    monkeypatch.setenv("HTTPS_PROXY", "http://proxy.test:8080")
    monkeypatch.setenv("NO_PROXY", "public.test")
    session = None
    def get(self, url, **kwargs):
        nonlocal session
        session = self
        assert not self.trust_env
        assert self.get_adapter(url).__class__.__name__ == "PinnedAdapter"
        return Response(url)
    monkeypatch.setattr(web.requests.Session, "get", get)
    opened, response = web._open_pinned_response("https://public.test/", {"8.8.8.8"}, 1)
    try:
        assert opened is session and response.status_code == 200
    finally:
        response.close()
        opened.close()


def test_unrelated_proxy_environment_metadata_does_not_block_direct_transport(monkeypatch):
    monkeypatch.setattr(web.requests.utils, "get_environ_proxies", lambda url: {"no": "other.test"})
    monkeypatch.setattr(web.requests.Session, "get", lambda self, url, **kwargs: Response(url))
    session, response = web._open_pinned_response("https://public.test/", {"8.8.8.8"}, 1)
    response.close()
    session.close()


class Response:
    raw = None
    encoding = "utf-8"
    text = "<html><title>Public page</title><p>Public content</p></html>"

    def __init__(self, url, status=200, location=None):
        self.url = url
        self.status_code = status
        self.headers = {"Location": location} if location else {}
        self.closed = False
        self.body_read = False

    def iter_content(self, chunk_size):
        self.body_read = True
        yield self.text.encode()

    def close(self):
        self.closed = True


@pytest.fixture
def transport(monkeypatch):
    calls, responses, events = [], [], []
    routes = {}

    def resolve(host):
        events.append(("resolve", host))
        return {"8.8.8.8"}

    def get(url, addresses, timeout):
        assert addresses == {"8.8.8.8"}
        events.append(("request", url))
        calls.append(url)
        status, location = routes.get(url, (200, None))
        response = Response(url, status, location)
        responses.append(response)
        from types import SimpleNamespace
        return SimpleNamespace(close=lambda: None), response

    monkeypatch.setattr(web, "_fetch_cache", {})
    monkeypatch.setattr(web, "_resolved_addresses", resolve)
    monkeypatch.setattr(web, "_open_pinned_response", get)
    return routes, calls, responses, events


def test_public_redirect_to_loopback_is_blocked_before_second_request(transport):
    routes, calls, responses, _ = transport
    routes["https://public.test/start"] = (302, "http://127.0.0.1/admin")
    result = web.fetch_and_extract("https://public.test/start")
    assert result["ok"] is False
    assert "blocked" in result["error"]
    assert calls == ["https://public.test/start"]
    assert responses[0].closed and not responses[0].body_read


@pytest.mark.parametrize("address", [
    "127.0.0.1", "10.0.0.1", "192.168.1.1", "169.254.169.254",
    "100.64.0.1", "224.0.0.1", "240.0.0.1", "0.0.0.0",
    "[::1]", "[fc00::1]", "[fe80::1]", "[ff02::1]", "[::]",
    "[::ffff:127.0.0.1]", "[::ffff:8.8.8.8]",
])
def test_non_public_literal_never_sends_request(transport, address):
    result = web.fetch_and_extract(f"http://{address}/")
    assert result["ok"] is False
    assert transport[1] == []


@pytest.mark.parametrize("answers", [set(), {"8.8.8.8", "10.0.0.1"}, {"8.8.8.8", "::1"}])
def test_all_dns_candidates_must_be_public(monkeypatch, transport, answers):
    monkeypatch.setattr(web, "_resolved_addresses", lambda host: answers)
    assert web.fetch_and_extract("https://public.test/")["ok"] is False
    assert transport[1] == []


def test_dns_failure_never_sends_request(monkeypatch, transport):
    def fail(host):
        raise OSError("DNS unavailable")
    monkeypatch.setattr(web, "_resolved_addresses", fail)
    assert web.fetch_and_extract("https://public.test/")["ok"] is False
    assert transport[1] == []


def test_public_redirect_chain_checks_every_hop_before_request(transport):
    routes, calls, responses, events = transport
    routes["https://public.test/start"] = (301, "/relative")
    routes["https://public.test/relative"] = (307, "https://other.test/final")
    result = web.fetch_and_extract("https://public.test/start")
    assert result["ok"] is True
    assert "Public content" in result["content"]
    assert calls == ["https://public.test/start", "https://public.test/relative", "https://other.test/final"]
    assert [event[0] for event in events] == ["resolve", "request"] * 3
    assert result["redirect"]["final_url"] == calls[-1]
    assert all(response.closed for response in responses)
    assert not any(response.body_read for response in responses[:-1])


def test_redirect_limit_never_sends_seventh_request(transport):
    routes, calls, responses, _ = transport
    for index in range(7):
        routes[f"https://public.test/{index}"] = (302, f"/{index + 1}")
    result = web.fetch_and_extract("https://public.test/0")
    assert result["ok"] is False
    assert "too many redirects" in result["error"]
    assert len(calls) == 6  # Original request plus five permitted redirects.
    assert all(response.closed for response in responses)


@pytest.mark.parametrize("target", [
    "file:///etc/passwd", "ftp://public.test/", "http:///missing-host",
    "https://user:FAKE_PASSWORD@public.test/", "https://public.test:99999/",
])
def test_invalid_url_or_redirect_never_contacts_target(transport, target, caplog):
    routes, calls, _, _ = transport
    result = web.fetch_and_extract(target)
    assert result["ok"] is False
    assert calls == []
    routes["https://public.test/start"] = (302, target)
    result = web.fetch_and_extract("https://public.test/start")
    assert result["ok"] is False
    assert calls == ["https://public.test/start"]
    assert "FAKE_PASSWORD" not in str(result) + caplog.text
