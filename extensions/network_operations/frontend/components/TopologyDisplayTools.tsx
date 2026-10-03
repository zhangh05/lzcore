import type { ReactNode } from 'react';
import type { ReferenceLine } from './TopologyReferenceLines';
import './TopologyToolGroups.css';
type Toggle = (value: boolean) => void;
export function TopologyDisplayTools(p: {
  toolsVisible: boolean; setToolsVisible: Toggle; grid: boolean; setGrid: Toggle; gridSnap: boolean; setGridSnap: Toggle; smartGuides: boolean; setSmartGuides: Toggle;
  interfaces: boolean; setInterfaces: Toggle; compact: boolean; setCompact: Toggle; observation: boolean; setObservation: Toggle;
  observationCount: number; editable: boolean; referenceLines: ReferenceLine[]; onChange: (lines: ReferenceLine[]) => void;
  onAddReference: (axis: 'x' | 'y') => void; referenceId: string | null; referenceName?: string;
  onSetReference: () => void; onClearReference: () => void; canSetReference: boolean; onFit: () => void; children: ReactNode;
}) {
  const check = (name: string, checked: boolean, change: Toggle) => <label><input type="checkbox" checked={checked} onChange={e=>change(e.target.checked)} />{name}</label>;
  return <>
    <details className="studio-display-menu" data-toolbar-menu><summary>显示</summary><div>
      <strong>画布显示</strong>
      {p.editable && check("绘图工具栏",p.toolsVisible,p.setToolsVisible)}
      {check('网格',p.grid,p.setGrid)}{check('接口标签',p.interfaces,p.setInterfaces)}{check('紧凑模式',p.compact,p.setCompact)}
      {check('最近检测结果',p.observation,p.setObservation)}
      <small>{p.observationCount ? `${p.observationCount} 台设备有最近记录；不代表当前健康` : '暂无可显示的检测记录'}</small>
      <button type="button" onClick={p.onFit}>适配视图 · F</button>{p.children}
    </div></details>
    {p.editable && <details className="studio-guides-menu" data-toolbar-menu data-keep-open><summary>辅助对齐</summary><div>
      {check('智能参考线',p.smartGuides,p.setSmartGuides)}{check('网格吸附',p.gridSnap,p.setGridSnap)}
      <small>{p.smartGuides ? '拖动设备接近其他设备的边缘或中心时显示长参考线：虚线提示接近，实线表示已对齐；继续靠近才轻微吸附。' : '设备间智能参考线与吸附已关闭。'}</small>
      <small>网格吸附和手动参考线独立生效。Shift + G 切换网格吸附。</small>
      <strong>设备基准</strong>
      <button type="button" disabled={!p.canSetReference} onClick={p.onSetReference}>以选中设备为基准</button>
      {p.referenceId && <><small>当前基准：{p.referenceName || p.referenceId}</small><button type="button" onClick={p.onClearReference}>取消设备基准</button></>}
      <strong>手动参考线</strong>
      <div className="reference-actions"><button type="button" disabled={p.referenceLines.length >= 100} onClick={()=>p.onAddReference('y')}>添加水平参考线</button><button type="button" disabled={p.referenceLines.length >= 100} onClick={()=>p.onAddReference('x')}>添加垂直参考线</button></div>
      <small>本机按工作区和图纸保存，不进入图纸导出。可拖动或输入坐标。</small>
      <div className="reference-line-editor">{p.referenceLines.map((line,index)=><div className="reference-line-row" key={line.id}>
        <span>{line.axis==='x'?'X':'Y'}</span>
        <input type="number" aria-label={`参考线 ${index+1} 坐标`} value={Number(line.position.toFixed(2))} disabled={line.locked}
          onChange={e=>{ if(e.target.value.trim() && Number.isFinite(e.target.valueAsNumber)) p.onChange(p.referenceLines.map(item=>item.id===line.id?{...item,position:e.target.valueAsNumber}:item)); }} />
        <label><input type="checkbox" aria-label={`锁定参考线 ${index+1}`} checked={line.locked} onChange={e=>p.onChange(p.referenceLines.map(item=>item.id===line.id?{...item,locked:e.target.checked}:item))} />锁定</label>
        <button type="button" aria-label={`删除参考线 ${index+1}`} onClick={()=>p.onChange(p.referenceLines.filter(item=>item.id!==line.id))}>删除</button>
      </div>)}</div>
    </div></details>}
  </>;
}
