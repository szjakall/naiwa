package db

import "testing"

func TestTaskLifecycleAndDeleteCascade(t *testing.T) {
	d, err := Open(testDSN(t))
	if err != nil {
		t.Skipf("postgres unavailable (%v) — skipping", err)
	}
	defer d.Close()

	tk, err := d.CreateTask("迁移测试", "迁移测试", "目标X", nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	// populate the exploration subgraph
	es := d.Exploration(tk.ExplorationID)
	if _, err := es.AddIntent(map[string]any{"summary": "x"}, 5, nil, "planner"); err != nil {
		t.Fatal(err)
	}

	// pause + status
	if err := d.SetPaused(tk.ID, true); err != nil {
		t.Fatal(err)
	}
	got, err := d.GetTask(tk.ID)
	if err != nil || got == nil || !got.Paused {
		t.Fatalf("paused not persisted: %+v err=%v", got, err)
	}

	// list contains it
	list, _ := d.ListTasks()
	found := false
	for _, x := range list {
		if x.ID == tk.ID {
			found = true
		}
	}
	if !found {
		t.Fatalf("task not in list")
	}

	// findings 记录的漏洞随任务删除（用户口径：任务删除即全清，不留孤儿行）
	if _, err := d.Exec(`INSERT INTO findings (task_id, vulnclass, severity, summary) VALUES ($1,'xss','low','t')`, tk.ID); err != nil {
		t.Fatal(err)
	}
	var fid int64
	if err := d.QueryRow(`SELECT id FROM findings WHERE task_id=$1`, tk.ID).Scan(&fid); err != nil {
		t.Fatal(err)
	}
	// 资产与任务关联：删除后应解除关联（资产本身保留）
	if _, err := d.Exec(`INSERT INTO assets (type, domain, task_ids) VALUES ('subdomain','a.example.com', ARRAY[$1]::bigint[])`, tk.ID); err != nil {
		t.Fatal(err)
	}

	// delete cascades exploration subgraph
	reportFiles, nodeIDs, expID, err := d.DeleteTask(tk.ID)
	if err != nil {
		t.Fatal(err)
	}
	if expID != tk.ExplorationID {
		t.Fatalf("expected exploration id %d, got %d", tk.ExplorationID, expID)
	}
	if g, _ := d.GetTask(tk.ID); g != nil {
		t.Fatalf("task should be gone")
	}
	var nodes int
	d.QueryRow(`SELECT count(*) FROM exploration_nodes WHERE exploration_id=$1`, tk.ExplorationID).Scan(&nodes)
	if nodes != 0 {
		t.Fatalf("exploration nodes should be cascade-deleted, got %d", nodes)
	}
	var exps int
	d.QueryRow(`SELECT count(*) FROM explorations WHERE id=$1`, tk.ExplorationID).Scan(&exps)
	if exps != 0 {
		t.Fatalf("exploration should be deleted, got %d", exps)
	}
	var findings int
	d.QueryRow(`SELECT count(*) FROM findings WHERE id=$1`, fid).Scan(&findings)
	if findings != 0 {
		t.Fatalf("findings of a deleted task should be deleted")
	}
	var linked int
	d.QueryRow(`SELECT count(*) FROM assets WHERE domain='a.example.com' AND $1 = ANY(task_ids)`, tk.ID).Scan(&linked)
	if linked != 0 {
		t.Fatalf("deleted task id should be detached from assets.task_ids")
	}
	d.Exec(`DELETE FROM assets WHERE domain='a.example.com'`) //nolint:errcheck
	// every node id (intent + the task's origin/root node) must be reported back
	// for on-disk cleanup (i<intentID>/ dirs and report_assets/evidence/<nodeID>/).
	if len(nodeIDs) < 1 {
		t.Fatalf("expected node ids for dir cleanup, got %v", nodeIDs)
	}
	if len(reportFiles) != 0 {
		t.Fatalf("expected no report files (none were created), got %v", reportFiles)
	}
	// a report row for the task must be cascade-deleted too
	if _, err := d.Exec(`INSERT INTO reports (task_id, task_desc, filename, path) VALUES ($1,'t','f.zip','/tmp/f.zip')`, tk.ID); err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := d.DeleteTask(tk.ID); err != nil { // already gone → no-op, no error
		t.Fatalf("second delete should be a no-op: %v", err)
	}
}
