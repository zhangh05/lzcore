"""Public-web fetch boundaries, with no network or real DNS access."""

import pytest

from core.tools.general_tools import web_content as web


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

    def get(url, **kwargs):
        assert kwargs["allow_redirects"] is False
        assert kwargs["stream"] is True
        events.append(("request", url))
        calls.append(url)
        status, location = routes.get(url, (200, None))
        response = Response(url, status, location)
        responses.append(response)
        return response

    monkeypatch.setattr(web, "_fetch_cache", {})
    monkeypatch.setattr(web, "_resolved_addresses", resolve)
    monkeypatch.setattr(web.requests, "get", get)
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
