"""Canonical identity, one-time migration, region geometry and governed edits."""
import hashlib

import pytest

from extensions.network_operations import topology_service as drawings
from extensions.network_operations.drawing_feedback import geometry_feedback
from extensions.network_operations.region_geometry import migrate_regions, region_bounds, region_contains
from extensions.sdk import ExtensionDataStore


def drawing(**extra):
    return drawings.save_topology('default', {'name': 'regions', 'nodes': [
        {'node_id': 'a', 'region_id': 'A', 'x': 100, 'y': 100},
        {'node_id': 'b', 'region_id': 'B', 'x': 110, 'y': 100}],
        'canvas_items': [dict(item_id=key, kind='rectangle', text='same', auto_fit=True) for key in ['A', 'B']], **extra})


@pytest.mark.parametrize('kind', ['rectangle', 'ellipse'])
def test_fit_uses_only_bound_members_and_contains_footprints(temp_dirs, kind):
    topo = drawing(canvas_items=[dict(item_id=key, kind=kind, text='same', auto_fit=True) for key in ['A', 'B']])
    for item in topo['canvas_items']:
        members = [n for n in topo['nodes'] if n['region_id'] == item['item_id']]
        assert item['x'] == members[0]['x']
        assert all(region_contains(item, n) for n in members)
    assert len(topo['canvas_items']) == 2


def test_missing_region_and_old_aliases_fail_without_mutation(temp_dirs):
    topo = drawing()
    for update, error in [({'region_id': 'missing'}, 'topology_region_not_found'),
                          ({'region_id': 'same'}, 'topology_region_not_found'),
                          ({'zone': 'same'}, 'topology_legacy_region_fields'),
                          ({'group_id': 'A'}, 'topology_legacy_region_fields')]:
        with pytest.raises(ValueError, match=error):
            drawings.patch_topology('default', topo['topology_id'], {'node_updates': [{'node_id': 'a', **update}]})
        assert drawings.get_topology('default', topo['topology_id']) == topo
    for key in ['groups', 'zones', 'group_updates', 'remove_group_ids']:
        with pytest.raises(ValueError, match='topology_legacy_regions_removed'):
            drawings.patch_topology('default', topo['topology_id'], {key: []})


def test_delete_and_rebind_is_atomic_and_never_regenerates(temp_dirs):
    topo = drawing()
    changed = drawings.patch_topology('default', topo['topology_id'], {'remove_canvas_item_ids': ['A'],
        'node_updates': [{'node_id': 'a', 'region_id': 'B'}]})
    assert {n['region_id'] for n in changed['nodes']} == {'B'}
    assert [i['item_id'] for i in changed['canvas_items']] == ['B']
    changed = drawings.patch_topology('default', topo['topology_id'], {'remove_canvas_item_ids': ['B']})
    assert all(n['region_id'] is None for n in changed['nodes'])
    assert drawings.save_topology('default', changed)['canvas_items'] == []


def test_migration_is_backed_up_idempotent_and_does_not_guess_same_names(temp_dirs):
    store = ExtensionDataStore('network.operations', workspace_id='default')
    old = {'schema_version': 2, 'topology_id': 'old', 'name': 'old', 'version': 8,
           'nodes': [{'node_id': 'a', 'group_id': 'A', 'zone': 'same', 'x': 0, 'y': 0},
                     {'node_id': 'b', 'zone': 'same', 'x': 10, 'y': 0}], 'links': [], 'groups': [],
           'canvas_items': [dict(item_id=key, kind='rectangle', text='same', x=0, y=0, width=300, height=200) for key in ['A', 'B']]}
    store.save('topologies', 'old', old)
    migrated = drawings.get_topology('default', 'old')
    assert [n['region_id'] for n in migrated['nodes']] == ['A', None]
    assert migrated['region_migration_issues'] == [{'node_id': 'b', 'reason': 'ambiguous_region'}]
    assert migrated['version'] == 9
    assert store.get('topology_region_backups', 'old') == old
    assert drawings.get_topology('default', 'old') == migrated
    assert all('zone' not in n and 'group_id' not in n for n in migrated['nodes'])


def test_legacy_duplicated_autobox_is_consolidated_only_during_migration():
    key = 'zone-' + hashlib.sha256(b'internet').hexdigest()[:16]
    old = {'schema_version': 2, 'nodes': [{'node_id': 'a', 'group_id': key, 'zone': 'internet'}], 'groups': [],
           'canvas_items': [{'item_id': 'authored', 'kind': 'rectangle', 'text': 'Internet', 'zone': 'internet', 'auto_fit': False},
                            {'item_id': key, 'kind': 'rectangle', 'text': 'internet', 'zone': 'internet', 'auto_fit': True}]}
    migrated = migrate_regions(old)
    assert migrated['nodes'][0]['region_id'] == 'authored'
    assert [i['item_id'] for i in migrated['canvas_items']] == ['authored']
    assert migrate_regions(migrated) == migrated
    assert len(old['canvas_items']) == 2


def test_feedback_reports_empty_unbound_outside_and_identical_boxes(temp_dirs):
    topo = drawing(nodes=[{'node_id': 'a', 'region_id': 'A', 'x': 900, 'y': 900}, {'node_id': 'b', 'x': 0, 'y': 0}],
                   canvas_items=[dict(item_id=k, kind='rectangle', x=0, y=0, width=300, height=200, auto_fit=False) for k in ['A', 'B']])
    feedback = geometry_feedback(topo)['regions']
    assert feedback['outside_members'] == [{'node_id': 'a', 'item_id': 'A'}]
    assert feedback['unassigned_node_ids'] == ['b']
    assert feedback['empty_region_ids'] == ['B']
    assert feedback['identical_region_pairs'] == [['A', 'B']]


def test_region_grid_layout_separates_regions_and_preserves_fixed_frames(temp_dirs):
    topo = drawing(nodes=[{'node_id': str(i), 'region_id': 'A' if i % 2 else 'B', 'x': i, 'y': 0} for i in range(12)])
    changed = drawings.patch_topology('default', topo['topology_id'], {'layout': {'algorithm': 'grid'}})
    feedback = geometry_feedback(changed)
    assert feedback['node_overlap_count'] == 0
    assert feedback['regions']['outside_members'] == []
    assert feedback['regions']['overlapping_region_pairs'] == []
    fixed = drawings.patch_topology('default', topo['topology_id'], {'canvas_item_updates': [{'item_id': 'A', 'auto_fit': False, 'width': 40, 'height': 24}]})
    updated = drawings.patch_topology('default', topo['topology_id'], {'layout': {'algorithm': 'grid'}})
    assert next(i for i in updated['canvas_items'] if i['item_id'] == 'A') == next(i for i in fixed['canvas_items'] if i['item_id'] == 'A')
    assert [n for n in updated['nodes'] if n['region_id'] == 'A'] == [n for n in fixed['nodes'] if n['region_id'] == 'A']


def test_geometry_reference_vector_and_fixed_frame_feedback():
    nodes = [{'x': 100, 'y': 200}, {'x': 300, 'y': 400}]
    assert region_bounds(nodes) == {'x': 200, 'y': 288, 'width': 380, 'height': 384}
    ellipse = dict(kind='ellipse', **region_bounds(nodes, 'ellipse'))
    assert all(region_contains(ellipse, n) for n in nodes)


def test_region_overlap_feedback_is_bounded_without_losing_counts():
    boxes = [dict(item_id=str(i),kind='rectangle',x=0,y=0,width=240,height=180) for i in range(100)]
    feedback = geometry_feedback({'nodes': [], 'canvas_items': boxes})['regions']
    assert feedback['identical_region_count'] == 4950
    assert len(feedback['identical_region_pairs']) == 50
    assert feedback['region_pairs_complete'] is False


def test_layout_validates_geometry_even_when_all_nodes_protected(temp_dirs):
    topo = drawing()
    with pytest.raises(ValueError, match='drawing_layout_geometry_invalid'):
        drawings.patch_topology('default', topo['topology_id'], {'layout': {
            'algorithm': 'grid', 'spacing_x': 0, 'preserve_node_ids': ['a', 'b']}})
    assert drawings.get_topology('default', topo['topology_id']) == topo


def test_layout_avoids_empty_fixed_region(temp_dirs):
    topo = drawings.save_topology('default', {'nodes': [{'node_id': 'a', 'x': 500, 'y': 500}],
        'canvas_items': [{'item_id': 'empty', 'kind': 'rectangle', 'x': 200, 'y': 200,
                          'width': 400, 'height': 400, 'auto_fit': False}]})
    changed = drawings.patch_topology('default', topo['topology_id'], {'layout': {'algorithm': 'grid'}})
    assert changed['canvas_items'] == topo['canvas_items']
    assert changed['nodes'][0]['x'] - 70 >= 400


def test_legacy_inverse_edit_preserves_binding_to_unchanged_frame(temp_dirs):
    store = ExtensionDataStore('network.operations', workspace_id='default')
    old = {'schema_version': 2, 'topology_id': 'history', 'name': 'history', 'version': 2,
           'nodes': [{'node_id': 'a', 'group_id': 'A', 'x': 100, 'y': 100}], 'links': [], 'groups': [],
           'canvas_items': [{'item_id': 'A', 'kind': 'rectangle', 'text': 'A', 'x': 0, 'y': 0, 'width': 400, 'height': 400}]}
    before = {**old, 'version': 1, 'nodes': [{**old['nodes'][0], 'x': 50}]}
    edit = drawings._revision_edit(before, old)
    store.save(drawings._revision_collection('history'), 'rev', {
        'topology_id': 'history', 'revision_id': 'rev', 'snapshot': old, 'edit': edit})
    migrated = drawings.get_topology_revision('default', 'history', 'rev')['edit']
    assert migrated['before']['nodes'][0]['region_id'] == 'A'
    assert migrated['after']['nodes'][0]['region_id'] == 'A'
    assert migrated['before']['canvas_items'] == []  # unchanged frame remains outside the delta
    assert 'group_id' not in migrated['before']['nodes'][0]
    assert store.get(drawings._revision_collection('history'), 'rev')['edit'] == edit


def test_invalid_auto_fit_rejected_without_change(temp_dirs):
    topo = drawing()
    with pytest.raises(ValueError, match='topology_auto_fit_invalid'):
        drawings.patch_topology('default', topo['topology_id'], {'canvas_item_updates': [{'item_id': 'A', 'auto_fit': 'false'}]})
    assert drawings.get_topology('default', topo['topology_id']) == topo
