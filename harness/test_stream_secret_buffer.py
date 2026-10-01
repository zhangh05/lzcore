"""Secrets split across stream tokens must be redacted before send or persist."""

from storage.redaction import MASK, TokenSecretBuffer


def test_split_api_key_is_redacted_before_either_part_is_released():
    buffer = TokenSecretBuffer()
    first = buffer.push("prefix sk-abcd")
    second = buffer.push("efghijkl tail")
    released = first + second + buffer.flush()
    assert "sk-abcdefghijkl" not in released
    assert "sk-abcd" not in first
    assert MASK in released


def test_sensitive_prefixes_split_at_every_character():
    for text in ("sk-DEMO1234567890", "password=DEMO1234567890", "authorization: Bearer DEMO1234567890", "key=DEMO1234567890", "OPENAI_API_KEY=DEMO1234567890", "ipsec user DEMO1234567890"):
        for index in range(1, len(text)):
            buffer = TokenSecretBuffer()
            released = buffer.push(text[:index]) + buffer.push(text[index:]) + buffer.flush()
            assert "DEMO1234567890" not in released, (text.split('=')[0], index)


def test_character_tokens_never_release_a_secret():
    buffer = TokenSecretBuffer()
    released = ''.join(buffer.push(c) for c in "hello sk-DEMO1234567890 world") + buffer.flush()
    assert "DEMO1234567890" not in released
    assert "hello" in released and "world" in released
