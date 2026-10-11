"""Strict text transport: BOMs are evidence; legacy encodings are explicit."""
import codecs


def decode_text(raw: bytes, encoding: str | None = None) -> tuple[str, str, bytes]:
    bom = b''
    try:
        requested = codecs.lookup(encoding).name if encoding else None
    except LookupError as exc:
        raise ValueError('unknown_text_encoding') from exc
    for marker, codec in ((codecs.BOM_UTF32_LE, 'utf-32-le'),
                          (codecs.BOM_UTF32_BE, 'utf-32-be'),
                          (codecs.BOM_UTF8, 'utf-8'),
                          (codecs.BOM_UTF16_LE, 'utf-16-le'),
                          (codecs.BOM_UTF16_BE, 'utf-16-be')):
        compatible = {codec, 'utf-8-sig'} if codec == 'utf-8' else {codec, codec.rsplit('-', 1)[0]}
        if raw.startswith(marker) and (requested is None or requested in compatible):
            bom, encoding = marker, codec
            break
    encoding = encoding or 'utf-8'
    try:
        text = raw[len(bom):].decode(encoding, errors='strict')
        if '\x00' in text:
            raise ValueError('binary file cannot be read or edited as text')
        if bom + text.encode(encoding, errors='strict') != raw:
            raise ValueError('text_encoding_not_lossless')
    except (UnicodeError, LookupError, TypeError) as exc:
        raise ValueError('text_encoding_required: supply the known text encoding (for example gb18030); binary formats require their processor') from exc
    return text, encoding, bom
