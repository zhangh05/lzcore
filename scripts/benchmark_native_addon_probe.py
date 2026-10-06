"""Generic ObjectWrap GC probe for the shared compiler/runtime contract.

N-API-only checks miss classic addon cleanup regressions (nodejs/node#65446).
Use only an exclusively owned kernel-control project, never an application.
"""

from __future__ import annotations

OBJECTWRAP_SOURCE = """#include <node.h>
#include <node_object_wrap.h>
class Ephemeral final : public node::ObjectWrap {
 public:
  static void Allocate(const v8::FunctionCallbackInfo<v8::Value>& args) {
    auto isolate = args.GetIsolate();
    (new Ephemeral())->Wrap(args.This());
    args.GetReturnValue().Set(args.This());
  }
};
void Register(v8::Local<v8::Object> exports) {
  auto isolate = exports->GetIsolate();
  auto context = isolate->GetCurrentContext();
  auto constructor = v8::FunctionTemplate::New(isolate, Ephemeral::Allocate);
  constructor->InstanceTemplate()->SetInternalFieldCount(1);
  exports->Set(context, v8::String::NewFromUtf8Literal(isolate, "Ephemeral"),
               constructor->GetFunction(context).ToLocalChecked()).Check();
}
NODE_MODULE(probe, Register)
"""

GC_STRESS_PROGRAM = """const addon = require('./probe.node');
let pressure = [];
for (let i = 0; i < 300000; i++) {
  new addon.Ephemeral();
  pressure.push({index:i, buffer:'x'.repeat(1024)});
  if (pressure.length >= 1000) pressure = [];
}
console.log('native-gc-control-survived');
"""

TEMP_NATIVE_COMMAND = (
    "mkdir -p /tmp/lzcore-native-control && "
    "cp probe.node probe.cjs /tmp/lzcore-native-control/ && "
    "cd /tmp/lzcore-native-control && node --max-old-space-size=32 probe.cjs"
)


def verify_temporary_native_addon(client, context, mode: str):
    """Load the same compiled addon from ephemeral storage through ToolRuntime."""
    observed = client.invoke("exec.run", {
        "action": "shell", "command": TEMP_NATIVE_COMMAND, "timeout": 120,
    }, context=context)
    output = observed.output or {}
    return {
        "name": f"temporary_native_addon_gc_and_exit_{mode}",
        "passed": observed.status == "succeeded" and output.get("exit_code") == 0
        and output.get("stdout", "").strip() == "native-gc-control-survived",
        "runtime_status": observed.status, "exit_code": output.get("exit_code"),
        "runner": output.get("runner"), "stderr": output.get("stderr", "")[:1200],
    }


def verify_native_addon_gc(client, context, project_prefix: str, rounds: int = 3):
    """Compile against bundled headers; require GC, full execution and exit 0."""
    if type(rounds) is not int or not 1 <= rounds <= 10:
        raise ValueError("invalid_native_probe_rounds")
    checks = []
    for name, content in (("probe.cc", OBJECTWRAP_SOURCE), ("probe.cjs", GC_STRESS_PROGRAM)):
        result = client.invoke("workspace.file", {
            "action": "create", "filepath": project_prefix + "/" + name, "content": content,
        }, context=context)
        checks.append({"name": "native_gc_source_" + name, "passed": result.status == "succeeded"})
    build = client.invoke("exec.run", {
        "action": "shell", "command": "g++ -std=c++20 -shared -fPIC -I/usr/local/include/node -DNODE_GYP_MODULE_NAME=probe probe.cc -o probe.node",
        "timeout": 120,
    }, context=context)
    checks.append({"name": "classic_native_addon_compiles_using_image_headers", "passed": build.status == "succeeded"})
    for index in range(rounds):
        observed = client.invoke("exec.run", {
            "action": "shell", "command": "node --max-old-space-size=32 probe.cjs", "timeout": 120,
        }, context=context)
        output = observed.output or {}
        checks.append({
            "name": f"classic_native_addon_gc_and_exit_round_{index + 1}",
            "passed": observed.status == "succeeded" and output.get("exit_code") == 0
            and output.get("stdout", "").strip() == "native-gc-control-survived",
            "runtime_status": observed.status, "exit_code": output.get("exit_code"),
            "stderr": output.get("stderr", "")[:1200],
        })
    return checks
