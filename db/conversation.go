package db

import (
	"database/sql"
	"encoding/json"
	"time"
)

// ConvTokenSummary is one conversation's token total (sum of its kind='result'
// rows) with its profile + created_at, used to merge conversation usage into the
// dashboard's per-profile / daily token stats (which otherwise cover only tasks).
type ConvTokenSummary struct {
	LLMProfileID     *int64 `json:"llm_profile_id"`
	CreatedAt        string `json:"created_at"`
	InputTokens      int    `json:"input_tokens"`
	OutputTokens     int    `json:"output_tokens"`
	CacheReadTokens  int    `json:"cache_read_tokens"`
	CacheWriteTokens int    `json:"cache_write_tokens"`
}

// ConversationTokenSummaries returns one row per conversation with its summed
// result-row token usage (0 for conversations with no completed run yet).
func (d *DB) ConversationTokenSummaries() ([]ConvTokenSummary, error) {
	rows, err := d.Query(`
SELECT c.llm_profile_id, c.created_at::text,
       COALESCE(sum(ca.input_tokens),0), COALESCE(sum(ca.output_tokens),0),
       COALESCE(sum(ca.cache_read_tokens),0), COALESCE(sum(ca.cache_write_tokens),0)
FROM conversations c
LEFT JOIN conversation_activities ca ON ca.conversation_id = c.id AND ca.kind = 'result'
GROUP BY c.id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ConvTokenSummary{}
	for rows.Next() {
		var s ConvTokenSummary
		var pid sql.NullInt64
		if err := rows.Scan(&pid, &s.CreatedAt, &s.InputTokens, &s.OutputTokens, &s.CacheReadTokens, &s.CacheWriteTokens); err != nil {
			return nil, err
		}
		if pid.Valid {
			v := pid.Int64
			s.LLMProfileID = &v
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

// Conversation is one ChatGPT-style chat thread bound to an agent key. It lives
// independent of the pentest exploration graph — see schema.sql §I.
type Conversation struct {
	ID           int64     `json:"id"`
	AgentKey     string    `json:"agent_key"`
	Title        string    `json:"title"`
	LLMProfileID *int64    `json:"llm_profile_id,omitempty"`
	// 会话编排：审批模式（auto / review / ai）、形态（web / android）、绑定的设备 key。
	// 这三项决定这一条对话"怎么跑"，而不是全局设置——同一个操作员可能一条对话全自动、
	// 另一条对话要人工审批。
	ApprovalMode string    `json:"approval_mode"`
	Platform     string    `json:"platform"`
	DeviceKey    string    `json:"device_key"`
	// 目标推进：一句目标 + 轮次/停止状态（JSONB）。
	Goal      string          `json:"goal"`
	GoalState json.RawMessage `json:"goal_state"`
	CreatedAt time.Time       `json:"created_at"`
	UpdatedAt    time.Time `json:"updated_at"`
}

const convCols = `id, agent_key, title, llm_profile_id, approval_mode, platform, device_key, goal, goal_state, created_at, updated_at`

func scanConv(row interface{ Scan(...any) error }) (Conversation, error) {
	var c Conversation
	err := row.Scan(&c.ID, &c.AgentKey, &c.Title, &c.LLMProfileID, &c.ApprovalMode, &c.Platform, &c.DeviceKey, &c.Goal, &c.GoalState, &c.CreatedAt, &c.UpdatedAt)
	return c, err
}

// ConvOptions carries the per-conversation orchestration choices.
type ConvOptions struct {
	ApprovalMode string // auto | review | ai
	Platform     string // web | android
	DeviceKey    string // 仅 platform=android 时有意义
}

// CreateConversation opens a new chat thread for agentKey with an initial title.
// llmProfileID may be nil to use the globally active profile.
func (d *DB) CreateConversation(agentKey, title string, llmProfileID *int64, opts ConvOptions) (*Conversation, error) {
	approval := opts.ApprovalMode
	if approval == "" {
		approval = "auto"
	}
	platform := opts.Platform
	if platform == "" {
		platform = "web"
	}
	c, err := scanConv(d.QueryRow(`
INSERT INTO conversations(agent_key, title, llm_profile_id, approval_mode, platform, device_key)
VALUES ($1, $2, $3, $4, $5, $6)
RETURNING `+convCols, agentKey, title, llmProfileID, approval, platform, opts.DeviceKey))
	if err != nil {
		return nil, err
	}
	return &c, nil
}

// UpdateConversationSettings changes the orchestration choices of an existing thread.
func (d *DB) UpdateConversationSettings(id int64, opts ConvOptions) error {
	_, err := d.Exec(
		`UPDATE conversations SET approval_mode=$2, platform=$3, device_key=$4 WHERE id=$1`,
		id, opts.ApprovalMode, opts.Platform, opts.DeviceKey,
	)
	return err
}

// GetConversationApprovalMode returns the approval mode of one conversation
// (auto when the row is gone or the value is unexpected). Used by the tool gate
// on every side-effecting call, so it stays a single cheap primary-key lookup.
func (d *DB) GetConversationApprovalMode(id int64) (string, error) {
	mode, _, err := d.GetConversationGateInfo(id)
	return mode, err
}

// GetConversationGateInfo returns (approval_mode, agent_key) for the gate: the
// agent key is what the approval queue shows as "who asked", so an empty string
// there makes the pending list unreadable.
func (d *DB) GetConversationGateInfo(id int64) (string, string, error) {
	var mode, agentKey string
	err := d.QueryRow(`SELECT approval_mode, agent_key FROM conversations WHERE id=$1`, id).Scan(&mode, &agentKey)
	if err == sql.ErrNoRows {
		return "auto", "", nil
	}
	if err != nil {
		return "auto", "", err
	}
	switch mode {
	case "auto", "review", "ai":
		return mode, agentKey, nil
	}
	return "auto", agentKey, nil
}

// SetConversationGoal 保存会话目标（空串表示清除目标）。
func (d *DB) SetConversationGoal(id int64, goal string) error {
	_, err := d.Exec(`UPDATE conversations SET goal=$2 WHERE id=$1`, id, goal)
	return err
}

// SetConversationGoalState 保存目标推进状态（轮次 / 停止原因等）。
func (d *DB) SetConversationGoalState(id int64, state json.RawMessage) error {
	if len(state) == 0 {
		state = json.RawMessage("{}")
	}
	_, err := d.Exec(`UPDATE conversations SET goal_state=$2 WHERE id=$1`, id, state)
	return err
}

// GetConversationGoal 读取目标与状态。
func (d *DB) GetConversationGoal(id int64) (string, json.RawMessage, error) {
	var goal string
	var state []byte
	err := d.QueryRow(`SELECT goal, goal_state FROM conversations WHERE id=$1`, id).Scan(&goal, &state)
	if err == sql.ErrNoRows {
		return "", json.RawMessage("{}"), nil
	}
	if err != nil {
		return "", nil, err
	}
	if len(state) == 0 {
		state = []byte("{}")
	}
	return goal, json.RawMessage(state), nil
}

// GetConversationDeviceKey returns the device bound to a conversation ("" = none).
func (d *DB) GetConversationDeviceKey(id int64) (string, error) {
	var key string
	err := d.QueryRow(`SELECT device_key FROM conversations WHERE id=$1`, id).Scan(&key)
	if err == sql.ErrNoRows {
		return "", nil
	}
	return key, err
}

// UpdateConversationProfile sets (or clears) the LLM profile override for a conversation.
func (d *DB) UpdateConversationProfile(id int64, llmProfileID *int64) error {
	_, err := d.Exec(`UPDATE conversations SET llm_profile_id=$2 WHERE id=$1`, id, llmProfileID)
	return err
}

// ListConversations returns all threads, most-recently-updated first.
func (d *DB) ListConversations() ([]*Conversation, error) {
	rows, err := d.Query(`SELECT ` + convCols + ` FROM conversations ORDER BY updated_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []*Conversation{}
	for rows.Next() {
		c, err := scanConv(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, &c)
	}
	return out, rows.Err()
}

// GetConversation returns one thread (nil, nil if absent).
func (d *DB) GetConversation(id int64) (*Conversation, error) {
	c, err := scanConv(d.QueryRow(`SELECT `+convCols+` FROM conversations WHERE id=$1`, id))
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &c, nil
}

// RenameConversation sets a thread's title.
func (d *DB) RenameConversation(id int64, title string) error {
	_, err := d.Exec(`UPDATE conversations SET title=$2 WHERE id=$1`, id, title)
	return err
}

// TouchConversation bumps updated_at so the thread floats to the top of the list.
func (d *DB) TouchConversation(id int64) error {
	_, err := d.Exec(`UPDATE conversations SET updated_at=now() WHERE id=$1`, id)
	return err
}

// DeleteConversation removes a thread; its activities cascade via FK.
func (d *DB) DeleteConversation(id int64) error {
	_, err := d.Exec(`DELETE FROM conversations WHERE id=$1`, id)
	return err
}

// MaxConvActivitySeq 返回一条会话当前最大的活动 seq（没有活动时为 0）。
func (d *DB) MaxConvActivitySeq(convID int64) (int64, error) {
	var seq int64
	err := d.QueryRow(`SELECT COALESCE(MAX(seq),0) FROM conversation_activities WHERE conversation_id=$1`, convID).Scan(&seq)
	if err != nil {
		return 0, err
	}
	return seq, nil
}

// AppendConvActivity records one step of a conversation (human message or an agent
// execution step) and returns its id. Mirrors ExplorationStore.AppendActivity but
// keyed by conversation_id. Reuses the Activity struct (NodeID is ignored here).
func (d *DB) AppendConvActivity(convID int64, a Activity) (int64, error) {
	var id int64
	err := d.QueryRow(`
INSERT INTO conversation_activities(conversation_id, worker, kind, tool, tool_use_id, is_error, summary, detail, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens)
VALUES ($1,NULLIF($2,''),NULLIF($3,''),NULLIF($4,''),NULLIF($5,''),$6,NULLIF($7,''),NULLIF($8,''),$9,$10,$11,$12)
RETURNING id`, convID, utf8Clean(a.Worker), utf8Clean(a.Kind), utf8Clean(a.Tool), utf8Clean(a.ToolUseID), a.IsError,
		utf8Clean(a.Summary), utf8Clean(a.Detail), a.InputTokens, a.OutputTokens, a.CacheReadTokens, a.CacheWriteTokens).Scan(&id)
	return id, err
}

// ConvActivityList returns a conversation's steps after sinceID (exclusive) with
// the summary-only column set (detail is lazy-loaded via ConvActivityDetail).
func (d *DB) ConvActivityList(convID, sinceID int64, limit int) ([]Activity, int64, error) {
	if limit <= 0 {
		limit = 500
	}
	const cols = `id, COALESCE(worker,''), COALESCE(kind,''), COALESCE(tool,''), COALESCE(tool_use_id,''), is_error, COALESCE(summary,''), created_at, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens`
	rows, err := d.Query(`SELECT `+cols+`
FROM conversation_activities WHERE conversation_id=$1 AND id>$2 ORDER BY id LIMIT $3`, convID, sinceID, limit)
	if err != nil {
		return nil, sinceID, err
	}
	defer rows.Close()
	out := []Activity{}
	cursor := sinceID
	for rows.Next() {
		var a Activity
		if err := rows.Scan(&a.ID, &a.Worker, &a.Kind, &a.Tool, &a.ToolUseID, &a.IsError, &a.Summary, &a.CreatedAt,
			&a.InputTokens, &a.OutputTokens, &a.CacheReadTokens, &a.CacheWriteTokens); err != nil {
			return nil, sinceID, err
		}
		if a.ID > cursor {
			cursor = a.ID
		}
		out = append(out, a)
	}
	return out, cursor, rows.Err()
}

// ConvActivityDetail lazily returns the full detail blob for one step.
func (d *DB) ConvActivityDetail(convID, id int64) (string, error) {
	var s sql.NullString
	err := d.QueryRow(`SELECT detail FROM conversation_activities WHERE id=$1 AND conversation_id=$2`, id, convID).Scan(&s)
	if err == sql.ErrNoRows {
		return "", nil
	}
	return s.String, err
}
