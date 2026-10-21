package util

import "testing"

func TestUnescapeBackslashEscapes(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want string
	}{
		{"empty", "", ""},
		{"no escapes", "hello world", "hello world"},
		{"single newline", `line1\nline2`, "line1\nline2"},
		{"double newline becomes paragraph", `para1\n\npara2`, "para1\n\npara2"},
		{"tab and carriage return", `a\t b\r c`, "a\t b\r c"},
		{"tab and carriage prefixes in command words", `a\tb\rc`, `a\tb\rc`},
		{"escaped backslash preserved as literal", `keep\\nliteral`, `keep\nliteral`},
		{"leading escaped backslash decoded once", `\\nliteral`, `\nliteral`},
		{"trailing lone backslash kept verbatim", `tail\`, `tail\`},
		{"unknown escape kept verbatim", `\x not touched`, `\x not touched`},
		{"mixed real and escaped newlines", "real\n" + `and\nescaped`, "real\nand\nescaped"},
		{"unicode untouched", `中文段落\n下一段`, "中文段落\n下一段"},
		// Contract boundary: only \n \r \t \\ are decoded. Common regex /
		// path / formatter escape sequences such as \d, \w, \s, \u, \0 must
		// pass through verbatim — this lets users paste regex snippets or
		// printf-style format strings into --content without surprise
		// mutation. Anyone who genuinely wants the literal characters \\n
		// can either double the backslash or pipe the body via stdin.
		{"regex digit class untouched", `\d+\s*\w+`, `\d+\s*\w+`},
		{"unicode escape untouched", `café`, `café`},
		{"null escape untouched", `\0 sentinel`, `\0 sentinel`},
		{"windows path no special chars", `C:\Users\bob`, `C:\Users\bob`},
		{"backslash-quote pair untouched", `quote\"inside`, `quote\"inside`},
		{"windows path with command prefixes", `C:\new\temp\reports`, `C:\new\temp\reports`},
		{"UNC path", `\\server\new\temp`, `\\server\new\temp`},
		{"bare commands", `\text{a}\right)\times\to\theta\tau\rightarrow\rho\neq\nabla\nu\notin`, `\text{a}\right)\times\to\theta\tau\rightarrow\rho\neq\nabla\nu\notin`},
		{"adjacent bare commands", `a\neq b + \nabla f`, `a\neq b + \nabla f`},
		{"custom command words", `\newmacro{x} \render \transform`, `\newmacro{x} \render \transform`},
		{"prose around math", `before\n$\text{x}\n\r\t\\$\nafter`, "before\n" + `$\text{x}\n\r\t\\$` + "\nafter"},
		{"prose around code", "before\\n`\\n\\r\\t\\\\`\\nafter", "before\n`\\n\\r\\t\\\\`\nafter"},
		{"currency before math", `$100 and $\text{x}\n$\nafter`, "$100 and " + `$\text{x}\n$` + "\nafter"},
		{"closing dollar after space is not math", `$100 and $ \nnext`, "$100 and $ \nnext"},
		{"currency alone is not math", `$100\nnext`, "$100\nnext"},
		{"escaped dollars are not math", `\$a\n b\$`, "\\$a\n b\\$"},
		{"unmatched inline code", "before `text\\nnext", "before `text\nnext"},
		{"unmatched code run is indivisible", "``text\\nnext `\\n` after\\nline", "``text\nnext `\\n` after\nline"},
		{"triple backtick inline span", "```\\t\\r\\\\```\\nafter", "```\\t\\r\\\\```\nafter"},
		{"fence closes before prose", "```\n\\n\\r\\t\\\\\n```\nnext\\nline", "```\n\\n\\r\\t\\\\\n```\nnext\nline"},
		{"encoded fence closes before prose", "```text\\n\\t\\r\\\\\\n```\\nnext\\nline", "```text\\n\\t\\r\\\\\\n```\nnext\nline"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := UnescapeBackslashEscapes(tt.in)
			if got != tt.want {
				t.Errorf("UnescapeBackslashEscapes(%q) = %q, want %q", tt.in, got, tt.want)
			}
		})
	}
}

func TestUnescapeBackslashEscapesPreservesMarkdownLiterals(t *testing.T) {
	inputs := []string{
		`$$\Delta \ln P_{0,i}(a_{\text{exec}} \mid s_t) \propto \eta_{\text{lr}} \cdot \sigma\left(\gamma_1 R_{\text{somatic}} + \gamma_2 V_{\text{ego_appraisal}}\right)$$`,
		`$P_{0,i}(\text{烧水洗澡} \mid \text{睡前})$`,
		`$0 \sim 10000\text{ kcal}$`,
		`$a \times b \neq c \to d$`,
		`$\theta, \tau, \rho, \nu, \nabla x$`,
		`$\begin{matrix}a&b\\c&d\end{matrix}$`,
		`$$\begin{matrix}a & b \\ c & d\end{matrix}$$`,
		`$$\n\\begin{aligned}a&=b\\c&=d\n$$`,
		"$$\n" + `\begin{aligned}a&=b\\c&=d\end{aligned}` + "\n$$",
		"`\\text{a}\\right)\\neq\\n`",
		"``a ` \\n\\r\\t\\\\ b``",
		"`multiline\n\\n\\r\\t\\\\`",
		"```text\n\\n\\r\\t\\\\\n```",
		"~~~text\n\\n\\r\\t\\\\\n~~~",
		"````text\n```\n\\n\\r\\t\\\\\n````",
		"   ~~~text\r\n\\n\\r\\t\\\\\r\n   ~~~~",
		"```text\n\\n\\r\\t\\\\", // An unclosed fence still contains code.
		"```text\n~~~\n\\n\\r\\t\\\\\n```",
		"```text\n``` not a closing fence\n\\n\\r\\t\\\\\n```",
		"```text\nvalue\\n```\n\\n\\r\\t\\\\\n```",
		`$\text{C:\temp}\n\r\t\\$`,
		`$\text{escaped \$ stays inside}\n\r\t\\$`,
		`$$\text{single $ stays inside}\n\r\t\\$$`,
	}
	for _, input := range inputs {
		t.Run(input, func(t *testing.T) {
			if got := UnescapeBackslashEscapes(input); got != input {
				t.Fatalf("literal changed:\n got %q\nwant %q", got, input)
			}
		})
	}
}
