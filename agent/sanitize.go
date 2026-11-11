package agent

import (
	"regexp"
	"strings"
)

// Models occasionally emit pseudo tool-call markup INSIDE a string field of a
// structured tool call — observed in the wild as a report_finding whose summary
// ended with "</summary>\n<parameter name=\"evidence\">GET …". The real fields
// were trapped inside those blocks while the JSON fields stayed empty, so the
// stored finding carried raw markup in its summary and no evidence at all.
// splitLeakedMarkup recovers the trailing parameter blocks into the matching
// empty fields and returns a clean summary.

var (
	// a pseudo "close summary + open parameter block" seam inside a field value
	leakSeamRe = regexp.MustCompile(`(?s)</summary>\s*<parameter\s+name="([^"]+)"\s*>`)
	// one <parameter name="x">…</parameter> block (value may span lines)
	leakParamRe = regexp.MustCompile(`(?s)<parameter\s+name="([^"]+)"\s*>(.*?)</parameter>`)
	leakOpenRe  = regexp.MustCompile(`(?s)^\s*<summary>\s*`)
)

// splitLeakedMarkup cleans a text field that swallowed pseudo tool-call markup.
// fields maps parameter names (evidence, vulnclass, severity, …) to pointers of
// the corresponding already-parsed values: a leaked block fills a field only
// when that field is currently EMPTY (never overwrites real values). Returns
// the cleaned field text with all leaked markup removed.
func splitLeakedMarkup(text string, fields map[string]*string) string {
	if !strings.Contains(text, "</summary>") && !strings.Contains(text, "<parameter") {
		return text
	}
	clean := leakOpenRe.ReplaceAllString(text, "")
	// 1) seam cut: everything from "</summary>" on belongs to the other fields.
	//    Handled FIRST so the complete-block pass below can't consume the seam's
	//    opener and leave a stray "</summary>" behind.
	if loc := leakSeamRe.FindStringSubmatchIndex(clean); loc != nil {
		name, tail := clean[loc[2]:loc[3]], clean[loc[1]:]
		clean = clean[:loc[0]]
		rest := recoverLeakBlocks(tail, fields)
		rest = strings.TrimSpace(strings.ReplaceAll(rest, "</summary>", ""))
		// an unterminated block leaves raw value text with no closing tag
		rest = strings.TrimSpace(strings.TrimSuffix(rest, "</parameter>"))
		if rest != "" {
			assignLeakField(fields, name, rest)
		}
	}
	// 2) complete blocks anywhere in the remaining text (seamless leak shapes).
	clean = recoverLeakBlocks(clean, fields)
	// 3) stray tags (e.g. a lone "</summary>" remnant) are markup junk here.
	clean = strings.ReplaceAll(clean, "</summary>", "")
	return strings.TrimSpace(clean)
}

// recoverLeakBlocks strips complete <parameter …>…</parameter> blocks from s,
// assigning each block's value to its (empty) field; returns the leftover text.
func recoverLeakBlocks(s string, fields map[string]*string) string {
	return leakParamRe.ReplaceAllStringFunc(s, func(block string) string {
		m := leakParamRe.FindStringSubmatch(block)
		if m == nil {
			return ""
		}
		assignLeakField(fields, m[1], strings.TrimSpace(m[2]))
		return ""
	})
}

func assignLeakField(fields map[string]*string, name, val string) {
	if val == "" {
		return
	}
	if p, ok := fields[name]; ok && (p == nil || *p == "") {
		*p = val
	}
}
