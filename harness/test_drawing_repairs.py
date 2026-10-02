"""Regressions for saved drawing identity, manual geometry and safe progress."""
import pytest
from extensions.network_operations import topology_service as drawings


def _zone():
    return drawings.save_topology("default", {"name": "区域测试", "nodes": [
        {"node_id": "a", "zone": "核心区", "x": 100, "y": 100},
        {"node_id": "b", "zone": "核心区", "x": 300, "y": 200},
    ], "links": []})


def test_zone_rename_keeps_identity_without_duplicate_or_growth(temp_dirs):
    topo = _zone(); item = topo["canvas_items"][0]
    for text in ["核心区（优化）", "", "新的显示名称"]:
        topo = drawings.patch_topology("default", topo["topology_id"], {
            "version": topo["version"], "canvas_item_updates": [{"item_id": item["item_id"], "text": text}]})
        assert len(topo["canvas_items"]) == 1
        assert topo["canvas_items"][0]["item_id"] == item["item_id"]
        assert topo["canvas_items"][0]["text"] == text


@pytest.mark.parametrize("full_save", [False, True])
def test_removed_zone_does_not_reappear_on_later_save(temp_dirs, full_save):
    topo = _zone(); item_id = topo["canvas_items"][0]["item_id"]
    if full_save:
        topo = drawings.save_topology("default", {**topo, "canvas_items": []})
    else:
        topo = drawings.patch_topology("default", topo["topology_id"], {"remove_canvas_item_ids": [item_id]})
    assert topo["canvas_items"] == []
    assert all(not n.get("zone") and not n.get("group_id") for n in topo["nodes"])
    topo = drawings.patch_topology("default", topo["topology_id"], {"node_updates": [{"node_id": "a", "x": 400}]})
    assert topo["canvas_items"] == []


def test_manual_geometry_survives_node_move_until_auto_fit_restored(temp_dirs):
    topo = _zone(); item_id = topo["canvas_items"][0]["item_id"]
    topo = drawings.patch_topology("default", topo["topology_id"], {"canvas_item_updates": [
        {"item_id": item_id, "x": 900, "y": 800, "width": 600, "height": 500}]})
    assert topo["canvas_items"][0]["auto_fit"] is False
    topo = drawings.patch_topology("default", topo["topology_id"], {"node_updates": [{"node_id": "a", "x": 600}]})
    assert topo["canvas_items"][0]["x"] == 900
    topo = drawings.patch_topology("default", topo["topology_id"], {"canvas_item_updates": [{"item_id": item_id, "auto_fit": True}]})
    assert topo["canvas_items"][0]["x"] == 450


def test_legacy_duplicate_ids_are_repaired_without_new_objects(temp_dirs):
    topo = _zone(); item = topo["canvas_items"][0]
    topo = drawings.save_topology("default", {**topo, "canvas_items": [item, {**item, "text": "改名"}]})
    assert len(topo["canvas_items"]) == 1
    assert topo["canvas_items"][0]["item_id"] == item["item_id"]
    assert topo["canvas_items"][0]["text"] == "改名"


def test_old_generated_zone_copies_merge_but_manual_boxes_survive(temp_dirs):
    topo = _zone(); item = topo['canvas_items'][0]
    saved = drawings.save_topology('default', {**topo, 'canvas_items': [item,
        {**item, 'item_id':'zone-legacy-copy'},
        {**item, 'item_id':'manual-note', 'auto_fit':False, 'x':900},
    ]})
    assert {i['item_id'] for i in saved['canvas_items']} == {item['item_id'], 'manual-note'}


def test_noop_patch_does_not_increment_version_or_broadcast(temp_dirs, monkeypatch):
    topo = _zone(); notices = []
    monkeypatch.setattr(drawings, "_notify_topology_saved", lambda *args: notices.append(args))
    saved = drawings.patch_topology("default", topo["topology_id"], {"version": topo["version"],
        "node_updates": [{"node_id": "a", "x": 100}], "remove_canvas_item_ids": ["missing"]})
    assert saved["version"] == topo["version"]
    assert notices == []
    with pytest.raises(ValueError, match="topology_version_conflict"):
        drawings.patch_topology("default", topo["topology_id"], {"version": 0, "node_updates": [{"node_id": "a", "x": 999}]})
    assert drawings.get_topology("default", topo["topology_id"])["nodes"][0]["x"] == 100


def test_explicit_container_geometry_and_equal_labels_keep_separate_memberships(temp_dirs):
    topo = drawings.save_topology('default', {'name': 'fixed frames', 'nodes': [
        {'node_id': 'a', 'x': 100, 'y': 100, 'zone': '同名', 'group_id': 'first'},
        {'node_id': 'b', 'x': 800, 'y': 100, 'zone': '同名', 'group_id': 'second'},
    ], 'canvas_items': [
        {'item_id': key, 'kind': 'rectangle', 'text': '同名', 'x': x, 'y': 0, 'width': 400, 'height': 250}
        for key, x in [('first', 0), ('second', 700)]]})
    assert [(item['item_id'], item['x']) for item in topo['canvas_items']] == [('first', 0), ('second', 700)]
    assert [n['group_id'] for n in topo['nodes']] == ['first', 'second']
    assert all(item['auto_fit'] is False for item in topo['canvas_items'])
    removed = drawings.patch_topology('default', topo['topology_id'], {
        'version': topo['version'], 'remove_canvas_item_ids': ['first']})
    assert removed['nodes'][0]['group_id'] is None and removed['nodes'][0]['zone'] is None
    assert removed['nodes'][1]['group_id'] == 'second'
    assert [item['item_id'] for item in removed['canvas_items']] == ['second']



def test_topology_rename_synchronizes_managed_sessions_but_keeps_custom_titles(temp_dirs):
    from storage.session_store import create_session, get_session
    topo = _zone()
    metadata = {'topology_id': topo['topology_id'], 'topology_name': topo['name'],
                'workbench_selection': {'skill_id': f"drawing:{topo['topology_id']}", 'allow_edit': False}}
    create_session('default', title='其他会话', metadata={'workbench_selection': 'legacy-text'})
    managed = create_session('default', title='拓扑 · old', metadata=metadata)
    custom = create_session('default', title='用户自定义会话', metadata=metadata)
    drawings.patch_topology('default', topo['topology_id'], {'version': topo['version'], 'name': '新名称'})
    updated = get_session(managed['session_id'], 'default')
    assert updated['title'] == '拓扑 · 新名称'
    assert updated['metadata']['topology_name'] == '新名称'
    assert updated['metadata']['workbench_selection']['allow_edit'] is False
    assert get_session(custom['session_id'], 'default')['title'] == '用户自定义会话'
