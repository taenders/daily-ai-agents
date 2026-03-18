/**
 * PRD Quality Checker
 *
 * Reviews a PRD against a 10-category rubric and outputs a scored
 * gap analysis with actionable suggested edits.
 *
 * Usage:
 *   npm run prd-check path/to/prd.md
 *   cat prd.md | npm run prd-check
 */

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import fs from "fs";
import { fileURLToPath } from "url";
import { z } from "zod";

// ─── Schema ──────────────────────────────────────────────────────────────────

const CategoryScore = z.object({
  score: z.number().min(0).max(10),
  status: z.enum(["pass", "warning", "fail"]),
  findings: z.string().describe("What was found (or missing) in the PRD"),
  suggested_edits: z
    .array(z.string())
    .describe("Concrete, immediately actionable edits"),
});

const PRDAnalysis = z.object({
  overall_score: z.number().min(0).max(10),
  overall_grade: z.enum(["A", "B", "C", "D", "F"]),
  summary: z
    .string()
    .describe("2-3 sentence executive summary of the PRD quality"),
  categories: z.object({
    problem_statement: CategoryScore,
    target_users: CategoryScore,
    success_metrics: CategoryScore,
    functional_requirements: CategoryScore,
    non_functional_requirements: CategoryScore,
    edge_cases: CategoryScore,
    out_of_scope: CategoryScore,
    timeline_milestones: CategoryScore,
    dependencies_risks: CategoryScore,
    acceptance_criteria: CategoryScore,
  }),
  top_gaps: z
    .array(z.string())
    .describe("The 3-5 most critical gaps ranked by business impact"),
  priority_edits: z
    .array(z.string())
    .describe("The 3-5 highest-priority edits to make first"),
});

type PRDAnalysis = z.infer<typeof PRDAnalysis>;
type CategoryScore = z.infer<typeof CategoryScore>;

// ─── Rubric System Prompt ─────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a senior product manager with 15+ years shipping products at top tech companies. You review PRDs rigorously and give direct, specific, actionable feedback.

## Scoring Rubric (score each category 0–10)

### 1. problem_statement
- Is the core problem clearly defined with supporting evidence (data, research, anecdotes)?
- Is the business/user impact quantified?
- 0 = no problem statement | 5 = problem stated but vague | 10 = clear, evidence-backed problem with quantified impact

### 2. target_users
- Are user personas or segments defined with needs, pain points, and goals?
- Is there a primary vs secondary user distinction?
- 0 = no user definition | 5 = users mentioned but undeveloped | 10 = rich personas with needs, goals, pain points

### 3. success_metrics
- Are there measurable KPIs with baselines and targets?
- Is there a plan for how metrics will be tracked?
- 0 = no metrics | 5 = metrics mentioned but not measurable | 10 = SMART metrics with baselines, targets, and tracking plan

### 4. functional_requirements
- Are features described with specific, testable behavior (not just "we will build X")?
- Are requirements prioritized (must-have vs nice-to-have)?
- 0 = no requirements | 5 = high-level features listed | 10 = detailed, prioritized, testable requirements

### 5. non_functional_requirements
- Are performance (latency, throughput), security, privacy, compliance, and scalability requirements specified with concrete thresholds?
- 0 = no NFRs | 5 = some NFRs mentioned vaguely | 10 = comprehensive NFRs with specific thresholds

### 6. edge_cases
- Are edge cases, boundary conditions, error states, and failure modes identified with handling strategies?
- 0 = no edge cases | 5 = a few edge cases noted | 10 = comprehensive edge cases with handling strategies

### 7. out_of_scope
- Is there an explicit, reasoned list of what's NOT included?
- Are future considerations documented separately?
- 0 = no out-of-scope section | 5 = some exclusions noted | 10 = explicit, reasoned out-of-scope list

### 8. timeline_milestones
- Are phases and milestones defined with dates or durations and inter-dependencies?
- 0 = no timeline | 5 = high-level phases mentioned | 10 = detailed milestones with dates and dependencies

### 9. dependencies_risks
- Are technical and cross-team dependencies identified?
- Are risks assessed (likelihood × impact) with mitigation strategies?
- 0 = no risks/dependencies | 5 = some risks listed without mitigations | 10 = full risk register with mitigations

### 10. acceptance_criteria
- Are done criteria specific, testable, and verifiable for each major requirement?
- 0 = no acceptance criteria | 5 = vague done criteria | 10 = specific, testable criteria for all major features

## Scoring Guidelines
- 9–10: Exceeds standards
- 7–8: Meets most standards, minor gaps
- 5–6: Meets basics, notable gaps
- 3–4: Significant gaps that will cause problems
- 0–2: Missing or fundamentally inadequate

## Output Guidelines
- Be specific — quote or reference the PRD directly in findings
- Suggested edits must be concrete and immediately actionable (not "add more detail")
- overall_score = weighted average (problem_statement and success_metrics weighted 1.5×)
- top_gaps and priority_edits ranked by business impact`;

// ─── Core Agent Function ───────────────────────────────────────────────────────

export async function checkPRD(prdText: string): Promise<PRDAnalysis> {
  const client = new Anthropic();

  process.stderr.write("Analyzing PRD");
  const dots = setInterval(() => process.stderr.write("."), 800);

  try {
    const response = await client.messages.parse({
      model: "claude-opus-4-6",
      max_tokens: 8192,
      thinking: { type: "adaptive" },
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: `Review this PRD and return a complete gap analysis:\n\n---\n\n${prdText}`,
        },
      ],
      output_config: {
        format: zodOutputFormat(PRDAnalysis, "prd_analysis"),
      },
    });

    if (!response.parsed_output) {
      throw new Error("Failed to parse structured output from Claude");
    }
    return response.parsed_output;
  } finally {
    clearInterval(dots);
    process.stderr.write(" done.\n\n");
  }
}

// ─── Report Formatter ─────────────────────────────────────────────────────────

const CATEGORY_LABELS: Record<string, string> = {
  problem_statement: "Problem Statement",
  target_users: "Target Users & Personas",
  success_metrics: "Success Metrics",
  functional_requirements: "Functional Requirements",
  non_functional_requirements: "Non-Functional Requirements",
  edge_cases: "Edge Cases & Error States",
  out_of_scope: "Out of Scope",
  timeline_milestones: "Timeline & Milestones",
  dependencies_risks: "Dependencies & Risks",
  acceptance_criteria: "Acceptance Criteria",
};

function statusIcon(status: CategoryScore["status"]): string {
  return { pass: "✓", warning: "⚠", fail: "✗" }[status];
}

function scoreBar(score: number): string {
  const filled = Math.round(score);
  return "█".repeat(filled) + "░".repeat(10 - filled) + `  ${score.toFixed(1)}/10`;
}

function gradeColor(grade: PRDAnalysis["overall_grade"]): string {
  return { A: "Excellent", B: "Good", C: "Adequate", D: "Poor", F: "Failing" }[grade];
}

export function formatReport(analysis: PRDAnalysis): string {
  const divider = "─".repeat(64);
  const lines: string[] = [];

  lines.push("╔" + "═".repeat(62) + "╗");
  lines.push("║" + "  PRD QUALITY ANALYSIS".padEnd(62) + "║");
  lines.push("╚" + "═".repeat(62) + "╝");
  lines.push("");
  lines.push(
    `OVERALL  Grade ${analysis.overall_grade} — ${gradeColor(analysis.overall_grade)}`
  );
  lines.push(`         ${scoreBar(analysis.overall_score)}`);
  lines.push("");
  lines.push("SUMMARY");
  lines.push(analysis.summary);
  lines.push("");
  lines.push(divider);
  lines.push("RUBRIC BREAKDOWN");
  lines.push(divider);

  for (const [key, value] of Object.entries(analysis.categories)) {
    const label = CATEGORY_LABELS[key] ?? key;
    const cat = value as CategoryScore;

    lines.push("");
    lines.push(`${statusIcon(cat.status)}  ${label.toUpperCase()}`);
    lines.push(`   Score:    ${scoreBar(cat.score)}`);
    lines.push(`   Findings: ${cat.findings}`);

    if (cat.suggested_edits.length > 0) {
      lines.push("   Edits:");
      for (const edit of cat.suggested_edits) {
        lines.push(`     → ${edit}`);
      }
    }
  }

  lines.push("");
  lines.push(divider);
  lines.push("TOP GAPS  (ranked by business impact)");
  lines.push(divider);
  analysis.top_gaps.forEach((gap, i) => {
    lines.push(`${i + 1}. ${gap}`);
  });

  lines.push("");
  lines.push(divider);
  lines.push("PRIORITY EDITS  (do these first)");
  lines.push(divider);
  analysis.priority_edits.forEach((edit, i) => {
    lines.push(`${i + 1}. ${edit}`);
  });

  lines.push("");
  return lines.join("\n");
}

// ─── CLI Entry Point ──────────────────────────────────────────────────────────

async function main() {
  let prdText: string;

  const filePath = process.argv[2];

  if (filePath) {
    if (!fs.existsSync(filePath)) {
      console.error(`Error: File not found: ${filePath}`);
      process.exit(1);
    }
    prdText = fs.readFileSync(filePath, "utf-8");
    process.stderr.write(`Loaded PRD from ${filePath} (${prdText.length} chars)\n`);
  } else if (!process.stdin.isTTY) {
    prdText = fs.readFileSync("/dev/stdin", "utf-8");
    process.stderr.write(`Read PRD from stdin (${prdText.length} chars)\n`);
  } else {
    console.error(
      "Usage:\n" +
        "  npm run prd-check path/to/prd.md\n" +
        "  cat prd.md | npm run prd-check\n"
    );
    process.exit(1);
  }

  if (prdText.trim().length < 50) {
    console.error("Error: PRD text too short — make sure the file has content.");
    process.exit(1);
  }

  const analysis = await checkPRD(prdText);
  console.log(formatReport(analysis));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error("Error:", err.message);
    process.exit(1);
  });
}
