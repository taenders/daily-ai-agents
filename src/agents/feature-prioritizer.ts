/**
 * Feature Prioritization Tool
 *
 * Analyzes a list of features and ranks them by priority using a
 * multi-dimensional scoring rubric. Outputs a tiered backlog with
 * scores, rationale, and actionable next steps.
 *
 * Usage:
 *   npm run prioritize path/to/features.md
 *   cat features.md | npm run prioritize
 */

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import fs from "fs";
import { fileURLToPath } from "url";
import { z } from "zod";

// ─── Schema ──────────────────────────────────────────────────────────────────

const DimensionScore = z.object({
  score: z.number().min(0).max(10),
  rationale: z.string().describe("1-2 sentence explanation for this score"),
});

const FeatureAnalysis = z.object({
  name: z.string().describe("Feature name, extracted or inferred from input"),
  description: z.string().describe("One-sentence description of the feature"),
  scores: z.object({
    user_value: DimensionScore.describe("How much value this delivers to users"),
    business_impact: DimensionScore.describe("Revenue, retention, or competitive impact"),
    strategic_alignment: DimensionScore.describe("Fit with product vision and company strategy"),
    effort: DimensionScore.describe("10 = trivial, 0 = massive engineering effort"),
    confidence: DimensionScore.describe("Confidence in impact estimates (data, research, validation)"),
    time_to_value: DimensionScore.describe("10 = users benefit immediately, 0 = very long delay"),
  }),
  priority_score: z
    .number()
    .min(0)
    .max(10)
    .describe("Weighted composite score — higher is more important to build"),
  tier: z
    .enum(["P0", "P1", "P2", "P3"])
    .describe("P0 = do now, P1 = next cycle, P2 = backlog, P3 = defer or cut"),
  key_risks: z.array(z.string()).describe("Top 1-3 risks if this feature ships (or doesn't)"),
  recommended_next_steps: z
    .array(z.string())
    .describe("Concrete actions to move this feature forward"),
});

const PrioritizationResult = z.object({
  summary: z
    .string()
    .describe("2-3 sentence executive summary of the prioritization"),
  features: z
    .array(FeatureAnalysis)
    .describe("All features ranked by priority_score descending"),
  top_recommendation: z
    .string()
    .describe("The single most important feature to start now and why"),
  strategic_themes: z
    .array(z.string())
    .describe("2-3 common themes across the highest-priority features"),
  defer_or_cut: z
    .array(z.string())
    .describe("Features to deprioritize, each with a brief reason"),
});

type PrioritizationResult = z.infer<typeof PrioritizationResult>;
type FeatureAnalysis = z.infer<typeof FeatureAnalysis>;
type DimensionScore = z.infer<typeof DimensionScore>;

// ─── Rubric System Prompt ─────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a senior product manager with 15+ years shipping products at top tech companies. You prioritize feature backlogs with rigor — balancing user needs, business impact, and engineering reality.

## Scoring Rubric (score each dimension 0–10)

### user_value
- How much does this improve users' lives or solve a real pain point?
- 0 = no user benefit | 5 = nice-to-have | 10 = solves a critical, frequent pain point

### business_impact
- Revenue potential, user retention, competitive differentiation, or cost reduction
- 0 = no business impact | 5 = moderate improvement to one metric | 10 = transformative business outcome

### strategic_alignment
- Does this advance the core product vision, roadmap, or company strategy?
- 0 = misaligned or distraction | 5 = somewhat related | 10 = directly accelerates the strategy

### effort (inverse — lower effort = higher score)
- Engineering complexity, cross-team dependencies, and risk of scope creep
- 0 = massive multi-quarter effort | 5 = 2-4 week sprint | 10 = can be done in hours

### confidence
- How validated are our assumptions about impact? (user research, data, experiments)
- 0 = pure speculation | 5 = some qualitative signals | 10 = strong quantitative evidence

### time_to_value
- How quickly do users or the business realize the benefit after shipping?
- 0 = benefit delayed 6+ months | 5 = 1-3 months | 10 = immediate value on launch

## Priority Score
Compute a weighted average using these weights:
- user_value: 1.5×
- business_impact: 1.5×
- strategic_alignment: 1.0×
- effort: 1.2×
- confidence: 0.8×
- time_to_value: 1.0×

## Tier Assignment
- P0 (do now): priority_score ≥ 8.0 — critical, high-confidence, high-impact
- P1 (next cycle): priority_score 6.0–7.9 — important, clear path forward
- P2 (backlog): priority_score 4.0–5.9 — worth doing, not urgent
- P3 (defer/cut): priority_score < 4.0 — low value or too speculative

## Output Guidelines
- Be specific — reference the feature description in your rationale
- Rank features within the features array by priority_score descending
- key_risks should be concrete, not generic ("integration with Salesforce CRM not yet scoped" not "there may be technical risks")
- recommended_next_steps must be immediately actionable (owners, deliverables, timeframe)
- If input is vague, make reasonable inferences and note them in the rationale`;

// ─── Core Agent Function ──────────────────────────────────────────────────────

export async function prioritizeFeatures(
  featuresText: string
): Promise<PrioritizationResult> {
  const client = new Anthropic();

  process.stderr.write("Prioritizing features");
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
          content: `Prioritize these features and return a complete analysis:\n\n---\n\n${featuresText}`,
        },
      ],
      output_config: {
        format: zodOutputFormat(PrioritizationResult, "prioritization_result"),
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

const TIER_LABELS: Record<string, string> = {
  P0: "DO NOW",
  P1: "NEXT CYCLE",
  P2: "BACKLOG",
  P3: "DEFER / CUT",
};

const TIER_ICONS: Record<string, string> = {
  P0: "▶▶",
  P1: "▶",
  P2: "─",
  P3: "✕",
};

const DIMENSION_LABELS: Record<string, string> = {
  user_value: "User Value",
  business_impact: "Business Impact",
  strategic_alignment: "Strategic Alignment",
  effort: "Effort (lower = harder)",
  confidence: "Confidence",
  time_to_value: "Time to Value",
};

function scoreBar(score: number): string {
  const filled = Math.round(score);
  return "█".repeat(filled) + "░".repeat(10 - filled) + `  ${score.toFixed(1)}/10`;
}

export function formatReport(result: PrioritizationResult): string {
  const divider = "─".repeat(64);
  const lines: string[] = [];

  lines.push("╔" + "═".repeat(62) + "╗");
  lines.push("║" + "  FEATURE PRIORITIZATION REPORT".padEnd(62) + "║");
  lines.push("╚" + "═".repeat(62) + "╝");
  lines.push("");
  lines.push("SUMMARY");
  lines.push(result.summary);
  lines.push("");

  // Group features by tier for the overview table
  const byTier: Record<string, FeatureAnalysis[]> = { P0: [], P1: [], P2: [], P3: [] };
  for (const f of result.features) {
    byTier[f.tier].push(f);
  }

  lines.push(divider);
  lines.push("PRIORITIZED BACKLOG");
  lines.push(divider);

  for (const tier of ["P0", "P1", "P2", "P3"] as const) {
    const features = byTier[tier];
    if (features.length === 0) continue;

    lines.push("");
    lines.push(`${TIER_ICONS[tier]}  ${tier} — ${TIER_LABELS[tier]}`);

    for (const feature of features) {
      lines.push("");
      lines.push(`   ┌─ ${feature.name.toUpperCase()}`);
      lines.push(`   │  Score:       ${scoreBar(feature.priority_score)}`);
      lines.push(`   │  Description: ${feature.description}`);
      lines.push(`   │`);
      lines.push(`   │  Scores:`);

      for (const [key, dim] of Object.entries(feature.scores)) {
        const label = (DIMENSION_LABELS[key] ?? key).padEnd(22);
        lines.push(`   │    ${label} ${scoreBar(dim.score)}`);
        lines.push(`   │    ${"".padEnd(22)} ${dim.rationale}`);
      }

      if (feature.key_risks.length > 0) {
        lines.push(`   │`);
        lines.push(`   │  Risks:`);
        for (const risk of feature.key_risks) {
          lines.push(`   │    ⚠ ${risk}`);
        }
      }

      if (feature.recommended_next_steps.length > 0) {
        lines.push(`   │`);
        lines.push(`   │  Next Steps:`);
        for (const step of feature.recommended_next_steps) {
          lines.push(`   │    → ${step}`);
        }
      }

      lines.push(`   └${"─".repeat(59)}`);
    }
  }

  lines.push("");
  lines.push(divider);
  lines.push("TOP RECOMMENDATION");
  lines.push(divider);
  lines.push(result.top_recommendation);

  if (result.strategic_themes.length > 0) {
    lines.push("");
    lines.push(divider);
    lines.push("STRATEGIC THEMES");
    lines.push(divider);
    result.strategic_themes.forEach((theme, i) => {
      lines.push(`${i + 1}. ${theme}`);
    });
  }

  if (result.defer_or_cut.length > 0) {
    lines.push("");
    lines.push(divider);
    lines.push("DEFER OR CUT");
    lines.push(divider);
    result.defer_or_cut.forEach((item, i) => {
      lines.push(`${i + 1}. ${item}`);
    });
  }

  lines.push("");
  return lines.join("\n");
}

// ─── CLI Entry Point ──────────────────────────────────────────────────────────

async function main() {
  let featuresText: string;

  const filePath = process.argv[2];

  if (filePath) {
    if (!fs.existsSync(filePath)) {
      console.error(`Error: File not found: ${filePath}`);
      process.exit(1);
    }
    featuresText = fs.readFileSync(filePath, "utf-8");
    process.stderr.write(`Loaded features from ${filePath} (${featuresText.length} chars)\n`);
  } else if (!process.stdin.isTTY) {
    featuresText = fs.readFileSync("/dev/stdin", "utf-8");
    process.stderr.write(`Read features from stdin (${featuresText.length} chars)\n`);
  } else {
    console.error(
      "Usage:\n" +
        "  npm run prioritize path/to/features.md\n" +
        "  cat features.md | npm run prioritize\n"
    );
    process.exit(1);
  }

  if (featuresText.trim().length < 20) {
    console.error("Error: Features text too short — make sure the file has content.");
    process.exit(1);
  }

  const result = await prioritizeFeatures(featuresText);
  console.log(formatReport(result));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error("Error:", err.message);
    process.exit(1);
  });
}
