"""Trusted positive/negative controls for added independent RTS assertions."""
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT=Path(__file__).resolve().parents[1]
PROGRAM=(ROOT/'harness/fixtures/coding_bench/rts_acceptance.cjs').read_text()
FIXTURE=r'''
const fixtureOptions = __OPTIONS__;
const __engineBridge = {
 async createGame(options) {
   const state={tick:0,units:[{id:'u0',owner:0,pos:{x:5,y:5},hp:100},{id:'u1',owner:1,pos:{x:100,y:100},hp:100}],
     buildings:[],resources:[{alloy:100,energy:100},{alloy:100,energy:100}],pathQueue:0,stats:{},projectiles:[]};
   const cells=fixtureOptions.shortFog?16383:16384;
   const fogs=Array.from({length:2},()=>({explored:Array(cells).fill(0),visible:Array(cells).fill(0)}));
   if(fixtureOptions.invalidVisibility)fogs[0].visible[0]=1;
   if(fixtureOptions.noProjectiles)delete state.projectiles;
   if(fixtureOptions.invalidResources)state.resources[0].alloy=NaN;
   return {snapshot:()=>structuredClone(state),
     getState:()=>fixtureOptions.noFogs?{}:{fogs},
     debugScenario:()=>{
       if(!options.debug){
         if(fixtureOptions.mutateRejected)state.units.pop();
         if(!fixtureOptions.allowDebug)throw Error('debug_disabled');
       }
     }};
 },close:()=>{}
};
'''


@pytest.mark.parametrize('scenario,options,passed', [
 ('snapshot_contract',{},True),('normal_debug_guard',{},True),
 ('snapshot_contract',{'noProjectiles':True},False),
 ('snapshot_contract',{'noFogs':True},False),
 ('snapshot_contract',{'shortFog':True},False),
 ('snapshot_contract',{'invalidVisibility':True},False),
 ('snapshot_contract',{'invalidResources':True},False),
 ('normal_debug_guard',{'allowDebug':True},False),
 ('normal_debug_guard',{'mutateRejected':True},False),
])
def test_independent_contract_checks_reject_missing_or_dishonest_observations(scenario,options,passed):
    import json
    node=shutil.which('node')
    if not node:pytest.skip('Node is required for trusted verifier controls')
    # Only this trusted fixture runs on the host. Generated applications still
    # run exclusively in the separate networkless evaluator worker.
    result=subprocess.run([node,'-e',FIXTURE.replace('__OPTIONS__',json.dumps(options))+'\n'+PROGRAM,
       'evaluator','fixture','entry',scenario,'17'],capture_output=True,text=True,timeout=10)
    assert (result.returncode==0) is passed,result.stderr
