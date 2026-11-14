"""Simulated clock and transport cover queue, HTTP, and retry deadlines."""
from types import SimpleNamespace
import threading

import pytest

from core.resolution import location_providers as providers
from core.resolution.location_service import LocationResolver


@pytest.fixture
def clock(monkeypatch):
    now, waits = [100.0], []
    monkeypatch.setattr(providers.time, 'monotonic', lambda: now[0])
    def wait(seconds):
        waits.append(seconds)
        now[0] += seconds
    monkeypatch.setattr(providers._WAIT_EVENT, 'wait', wait)
    return now, waits


@pytest.mark.parametrize('value', ['86400', 'inf', 'nan'])
def test_retry_after_is_capped_and_last_failure_never_waits(monkeypatch, clock, value):
    now, waits = clock
    calls = []
    def get(*a, **kw):
        calls.append(kw['timeout'])
        assert sum(kw['timeout']) <= 106 - now[0]
        return SimpleNamespace(status_code=429, headers={'Retry-After': value})
    monkeypatch.setattr('requests.get', get)
    with pytest.raises(providers.LocationProviderUnavailable):
        providers._open_meteo_get(params={}, deadline=106)
    assert len(calls) == 2 and waits == [2.0]


def test_insufficient_budget_never_waits_or_retries(monkeypatch, clock):
    now, waits = clock
    calls = []
    monkeypatch.setattr('requests.get', lambda *a, **kw: calls.append(kw) or SimpleNamespace(status_code=429, headers={'Retry-After': '86400'}))
    with pytest.raises(providers.LocationProviderUnavailable, match='budget'):
        providers._photon_get(params={}, deadline=100.1)
    assert len(calls) == 1 and waits == []


def test_semaphore_queue_uses_remaining_budget(monkeypatch, clock):
    timeouts = []
    slots = SimpleNamespace(acquire=lambda **kw: timeouts.append(kw['timeout']) or False)
    monkeypatch.setattr('requests.get', lambda *a, **kw: pytest.fail('queue budget exhausted'))
    with pytest.raises(providers.LocationProviderUnavailable):
        providers._provider_get('https://invalid', params={}, slots=slots, provider_name='test', deadline=100.1)
    assert timeouts == pytest.approx([0.1])


def test_nominatim_rate_wait_and_lock_share_deadline(monkeypatch, clock):
    now, waits = clock
    cls = providers.NominatimLocationProvider
    monkeypatch.setattr(cls, '_last_request', 100.0)
    monkeypatch.setattr(cls, '_circuit_open_until', 0.0)
    monkeypatch.setattr('requests.get', lambda *a, **kw: pytest.fail('rate limit exceeds budget'))
    with pytest.raises(providers.LocationProviderUnavailable, match='budget'):
        cls._get('https://invalid', params={}, deadline=100.5)
    assert waits == []
    assert cls._lock.acquire(blocking=False)
    cls._lock.release()


def test_service_passes_one_deadline_to_forward_and_reverse(clock):
    seen = []
    class Provider:
        name, supports_reverse = 'fake', True
        def search(self, query, **kw):
            seen.append(kw['deadline'])
            return []
        def reverse(self, lat, lon, **kw):
            seen.append(kw['deadline'])
            return []
    resolver = LocationResolver((Provider(),), timeout=0.25)
    assert not resolver.resolve('budget city').ok
    assert not resolver.reverse(1, 2).ok
    assert seen == [100.25, 104.0]


def test_late_success_is_rejected_and_not_cached(clock):
    from core.resolution.location_models import LocationCandidate
    now, _ = clock
    class LateProvider:
        name = 'late'
        def search(self, query, **kw):
            now[0] = kw['deadline'] + 0.01
            return [LocationCandidate(query, 1, 2, self.name, place_type='city', population=1000000)]
    resolver = LocationResolver((LateProvider(),), timeout=0.1)
    result = resolver.resolve('late city')
    assert not result.ok and result.status == 'location_resolution_timeout'
    assert 'resolution_budget_exhausted' in result.warnings
    assert not resolver._cache


def test_nominatim_last_http_failure_does_not_sleep(monkeypatch, clock):
    now, waits = clock
    cls = providers.NominatimLocationProvider
    monkeypatch.setattr(cls, '_last_request', 0.0)
    monkeypatch.setattr(cls, '_circuit_open_until', 0.0)
    calls = []
    monkeypatch.setattr('requests.get', lambda *a, **kw: calls.append(kw) or SimpleNamespace(status_code=429, headers={'Retry-After': '86400'}))
    with pytest.raises(providers.LocationProviderUnavailable):
        cls._get('https://invalid', params={}, deadline=106.0)
    assert len(calls) == 2 and waits == [2.0]
