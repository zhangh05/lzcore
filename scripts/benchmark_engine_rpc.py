"""Process-separated engine observation. Generated code never sees verifier code.

The untrusted engine and compiler live in the disposable container. The host
verifier reads bounded JSON observations and owns assertions/random scenarios.
"""

ENGINE_WORKER = r"""
const readline = require('node:readline');
(async () => {
  const entry = process.argv[1];
  const esbuild = require('/project/node_modules/esbuild');
  const bundle = await esbuild.build({entryPoints:[entry],bundle:true,write:false,platform:'node',format:'cjs',logLevel:'silent'});
  const Module = require('node:module');
  const compiled = new Module(entry, module);
  compiled.filename = entry; compiled.paths = Module._nodeModulePaths('/project');
  compiled._compile(bundle.outputFiles[0].text, entry);
  const engine = compiled.exports;
  const encode = value => JSON.stringify(value, (_, item) => ArrayBuffer.isView(item) ? Array.from(item) : item);
  const games = new Map();
  const methods = new Set(['step','snapshot','command','debugScenario','save','load','getState']);
  for await (const line of readline.createInterface({input:process.stdin,crlfDelay:Infinity})) {
    let request;
    try {
      request = JSON.parse(line);
      if (request.op === 'create') {
        const game = await engine.createGame(request.arguments[0]);
        games.set(request.game, game);
        process.stdout.write('lzcore-rpc:'+JSON.stringify({seq:request.seq,ok:true,result:null})+'\n');
      } else {
        if (!methods.has(request.op) || !games.has(request.game)) throw Error('invalid_engine_operation');
        const game = games.get(request.game);
        if (typeof game[request.op] !== 'function') throw Error('missing_engine_method:'+request.op);
        const result = await game[request.op](...request.arguments);
        process.stdout.write('lzcore-rpc:'+encode({seq:request.seq,ok:true,result:result??null})+'\n');
      }
    } catch(error) {
      process.stdout.write('lzcore-rpc:'+JSON.stringify({seq:request?.seq,ok:false,error:String(error.message).slice(0,1000)})+'\n');
    }
  }
  process.exit(0);
})().catch(error=>{ console.error(String(error.message).slice(0,1000));process.exit(1); });
"""

HOST_BRIDGE = r"""
const {spawn} = require('node:child_process');
const rpcConfiguration = JSON.parse(process.argv[6]);
const rpcChild = spawn(rpcConfiguration[0], rpcConfiguration.slice(1), {stdio:['pipe','pipe','pipe']});
let rpcSequence=0, rpcError='', rpcExited=false;
const rpcPending=new Map();
let rpcBuffer="";
rpcChild.stderr.on('data',chunk=>{rpcError=(rpcError+chunk).slice(-4000);});
function rpcFail(error){for(const item of rpcPending.values()){clearTimeout(item.timer);item.reject(error);}rpcPending.clear();}
rpcChild.on('error',error=>rpcFail(error));
rpcChild.on('exit',code=>{rpcExited=true;rpcFail(Error('engine_worker_exited:'+code+':'+rpcError));});
function rpcLine(line){
  if(!line.startsWith('lzcore-rpc:'))return;
  try{
    if(line.length>32*1024*1024)throw Error('engine_observation_too_large');
    const record=JSON.parse(line.slice(11));
    const item=rpcPending.get(record.seq);if(!item)throw Error('unexpected_engine_response');
    clearTimeout(item.timer);rpcPending.delete(record.seq);
    if(record.ok===true)item.resolve(record.result);else item.reject(Error(record.error||'engine_operation_failed'));
  }catch(error){rpcFail(error);}
}
rpcChild.stdout.on('data',chunk=>{
  rpcBuffer+=chunk.toString('utf8');
  if(rpcBuffer.length>32*1024*1024){rpcFail(Error('engine_observation_too_large'));rpcChild.kill();return;}
  let end;while((end=rpcBuffer.indexOf('\n'))>=0){const line=rpcBuffer.slice(0,end);rpcBuffer=rpcBuffer.slice(end+1);rpcLine(line);}
});
function rpcRequest(game,op,args){
  if(rpcExited)return Promise.reject(Error('engine_worker_closed'));
  const seq=++rpcSequence;
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{rpcPending.delete(seq);reject(Error('engine_operation_timeout:'+op));},25000);
    rpcPending.set(seq,{resolve,reject,timer});
    rpcChild.stdin.write(JSON.stringify({seq,game,op,arguments:args})+'\n',error=>{if(error)rpcFail(error);});
  });
}
const __engineBridge={
  async createGame(options){
    const id='game-'+(++rpcSequence);await rpcRequest(id,'create',[options]);
    return Object.fromEntries(['step','snapshot','command','debugScenario','save','load','getState'].map(method=>[method,(...args)=>rpcRequest(id,method,args)]));
  },
  async close(){
    rpcChild.stdin.end();
    if(rpcExited)return;
    await new Promise(resolve=>{const timer=setTimeout(()=>{rpcChild.kill();resolve();},3000);rpcChild.once('exit',()=>{clearTimeout(timer);resolve();});});
  }
};
"""
