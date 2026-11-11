package agent

import "testing"

// Reproduces the field shape of the three corrupted findings observed on
// 2026-11-02/03 (findings #30/#34/#54 in the production DB): the model wrapped
// its report_finding content in pseudo tool-call markup and the whole thing
// landed in the summary string with evidence left empty.
func TestSplitLeakedMarkupFinding34Shape(t *testing.T) {
	summary := "api.example.com 暴露完整 Swagger UI 与 OpenAPI 文档：GET /api-json（200）。" +
		"</summary>\n<parameter name=\"evidence\">curl -sk \"https://api.example.com/api-json\" -> HTTP 200, {\"openapi\":\"3.0.0\"}</parameter>"
	evidence := ""
	got := splitLeakedMarkup(summary, map[string]*string{"evidence": &evidence})
	if got != "api.example.com 暴露完整 Swagger UI 与 OpenAPI 文档：GET /api-json（200）。" {
		t.Fatalf("summary not cleaned: %q", got)
	}
	if evidence != "curl -sk \"https://api.example.com/api-json\" -> HTTP 200, {\"openapi\":\"3.0.0\"}" {
		t.Fatalf("evidence not recovered: %q", evidence)
	}
}

func TestSplitLeakedMarkupUnterminated(t *testing.T) {
	summary := "S3 桶允许匿名 ListBucket。</summary>\n<parameter name=\"evidence\">GET https://x.s3.amazonaws.com/?list-type=2 -> 200"
	evidence := ""
	got := splitLeakedMarkup(summary, map[string]*string{"evidence": &evidence})
	if got != "S3 桶允许匿名 ListBucket。" {
		t.Fatalf("summary not cleaned: %q", got)
	}
	if evidence != "GET https://x.s3.amazonaws.com/?list-type=2 -> 200" {
		t.Fatalf("evidence not recovered: %q", evidence)
	}
}

func TestSplitLeakedMarkupKeepsExistingField(t *testing.T) {
	summary := "正常摘要</summary>\n<parameter name=\"evidence\">泄漏的内容</parameter>"
	evidence := "已有证据"
	got := splitLeakedMarkup(summary, map[string]*string{"evidence": &evidence})
	if got != "正常摘要" {
		t.Fatalf("summary not cleaned: %q", got)
	}
	if evidence != "已有证据" { // never overwrite a filled field
		t.Fatalf("existing evidence clobbered: %q", evidence)
	}
}

func TestSplitLeakedMarkupUntouched(t *testing.T) {
	s := "完全正常的摘要，包含 <b>HTML</b> 与 </summary> 一词的普通讨论"
	e := ""
	got := splitLeakedMarkup(s, map[string]*string{"evidence": &e})
	// prose without parameter blocks passes through except stray markup tags —
	// a lone "</summary>" inside a summary field is treated as leak junk
	want := "完全正常的摘要，包含 <b>HTML</b> 与  一词的普通讨论"
	if got != want {
		t.Fatalf("unexpected output: %q (want %q)", got, want)
	}
}

func TestSplitLeakedMarkupMultipleBlocks(t *testing.T) {
	summary := "存储型 XSS 已确认。</summary>\n" +
		"<parameter name=\"evidence\">POST /msg -> 200, alert 渲染</parameter>\n" +
		"<parameter name=\"vulnclass\">存储型 XSS</parameter>"
	evidence, vulnclass := "", ""
	got := splitLeakedMarkup(summary, map[string]*string{"evidence": &evidence, "vulnclass": &vulnclass})
	if got != "存储型 XSS 已确认。" {
		t.Fatalf("summary not cleaned: %q", got)
	}
	if evidence != "POST /msg -> 200, alert 渲染" || vulnclass != "存储型 XSS" {
		t.Fatalf("fields not recovered: evidence=%q vulnclass=%q", evidence, vulnclass)
	}
}
