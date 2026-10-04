"""One Python input/output contract shared by execution adapters."""

import ast
import json


def build_program(code: str, input_data=None) -> str:
    ast.parse(code, mode="exec")
    payload = json.dumps(
        input_data if input_data is not None else {}, ensure_ascii=False, default=str
    )
    return (
        "import json as _runtime_json\n"
        f"input_data = _runtime_json.loads({payload!r})\n"
        + code
        + "\ntry:\n    _runtime_structured = result\nexcept NameError:\n    _runtime_structured = None\n"
        "if _runtime_structured is not None:\n"
        "    print('__LIANZHI_STRUCTURED__' + _runtime_json.dumps(_runtime_structured, ensure_ascii=False, default=str))\n"
    )


def decode_program_output(result: dict) -> dict:
    result = dict(result)
    visible = []
    structured = None
    for line in str(result.get("stdout") or "").splitlines():
        if line.startswith("__LIANZHI_STRUCTURED__"):
            try:
                structured = json.loads(line[len("__LIANZHI_STRUCTURED__") :])
            except ValueError:
                result["stderr"] = (
                    str(result.get("stderr") or "")
                    + "\nstructured result serialization failed"
                ).strip()
        else:
            visible.append(line)
    result.update(stdout="\n".join(visible), structured_output=structured)
    return result
