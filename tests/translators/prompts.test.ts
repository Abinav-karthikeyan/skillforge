import { afterEach, describe, expect, it } from "vitest";
import {
  applyCustomInstructions,
  interpolate,
  loadPrompt,
  resolvePromptVersion,
} from "../../src/translators/base.js";
import { CalibrationConfig } from "../../src/types/config.js";

const BASE_CONFIG: CalibrationConfig = {
  experience_level: "senior",
  tone: "balanced",
};

function withEnv(key: string, value: string | undefined, fn: () => void) {
  const previous = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    fn();
  } finally {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
}

afterEach(() => delete process.env.CAREER_MODE_PROMPT_VERSION);

describe("interpolate", () => {
  it("replaces known placeholders", () => {
    expect(interpolate("Hello {name}, level {level}", { name: "Ada", level: "senior" })).toBe(
      "Hello Ada, level senior"
    );
  });

  it("leaves unknown placeholders intact instead of crashing", () => {
    expect(interpolate("Hi {name}, {missing}", { name: "Ada" })).toBe("Hi Ada, {missing}");
  });

  it("handles templates with no placeholders", () => {
    expect(interpolate("plain text", { name: "Ada" })).toBe("plain text");
  });
});

describe("resolvePromptVersion", () => {
  it("returns the manifest active version by default", () => {
    expect(resolvePromptVersion("interview-qa")).toBe("v2");
    expect(resolvePromptVersion("portfolio-bullet")).toBe("v1");
    expect(resolvePromptVersion("technical-deepdive")).toBe("v1");
  });

  it("honors an explicit version argument", () => {
    expect(resolvePromptVersion("interview-qa", "v1")).toBe("v1");
  });

  it("throws for an unknown explicit version", () => {
    expect(() => resolvePromptVersion("interview-qa", "v99")).toThrow(/Unknown version/);
  });

  it("honors a global CAREER_MODE_PROMPT_VERSION env override", () => {
    withEnv("CAREER_MODE_PROMPT_VERSION", "v1", () => {
      expect(resolvePromptVersion("interview-qa")).toBe("v1");
    });
  });

  it("honors a per-mode CAREER_MODE_PROMPT_VERSION env override", () => {
    withEnv("CAREER_MODE_PROMPT_VERSION", "interview-qa@v1", () => {
      expect(resolvePromptVersion("interview-qa")).toBe("v1");
      expect(resolvePromptVersion("portfolio-bullet")).toBe("v1");
    });
  });

  it("throws when the env override names an unknown version for a mode", () => {
    withEnv("CAREER_MODE_PROMPT_VERSION", "interview-qa@v99", () => {
      expect(() => resolvePromptVersion("interview-qa")).toThrow(/[Uu]nknown version/);
    });
  });

  it("ignores an env override that matches no mode and no version", () => {
    withEnv("CAREER_MODE_PROMPT_VERSION", "bogus", () => {
      expect(resolvePromptVersion("interview-qa")).toBe("v2");
    });
  });

  it("prefers an explicit version over the env override", () => {
    withEnv("CAREER_MODE_PROMPT_VERSION", "v99", () => {
      expect(resolvePromptVersion("interview-qa", "v1")).toBe("v1");
    });
  });
});

describe("loadPrompt", () => {
  it("loads a prompt file and reports its version", () => {
    const { content, version } = loadPrompt("interview-qa", "v1");
    expect(version).toBe("interview-qa@v1");
    expect(content).toContain("{session_summary_json}");
    expect(content).toContain("{experience_level}");
  });

  it("loads the active version when none is specified", () => {
    const { version } = loadPrompt("portfolio-bullet");
    expect(version).toBe("portfolio-bullet@v1");
  });
});

describe("applyCustomInstructions", () => {
  it("returns the prompt unchanged when no custom instructions are set", () => {
    const prompt = "You are a coach.";
    expect(applyCustomInstructions(prompt, BASE_CONFIG, "interview-qa")).toBe(prompt);
  });

  it("appends a delimited block for flat string instructions", () => {
    const config: CalibrationConfig = {
      ...BASE_CONFIG,
      custom_instructions: "I target Staff roles at fintech companies.",
    };
    const result = applyCustomInstructions("You are a coach.", config, "interview-qa");

    expect(result).toContain("You are a coach.");
    expect(result).toContain("Additional context from the user");
    expect(result).toContain("I target Staff roles at fintech companies.");
    expect(result).toContain("---");
  });

  it("appends global plus mode-specific instructions for an object config", () => {
    const config: CalibrationConfig = {
      ...BASE_CONFIG,
      custom_instructions: {
        global: "Emphasize reliability.",
        "interview-qa": "Weight leadership stories more heavily.",
      },
    };
    const result = applyCustomInstructions("You are a coach.", config, "interview-qa");

    expect(result).toContain("Emphasize reliability.");
    expect(result).toContain("Weight leadership stories more heavily.");
  });

  it("only applies the mode-specific override for the matching mode", () => {
    const config: CalibrationConfig = {
      ...BASE_CONFIG,
      custom_instructions: {
        "portfolio-bullet": "Lead with impact metrics.",
      },
    };
    const result = applyCustomInstructions("You are a coach.", config, "interview-qa");

    expect(result).not.toContain("Lead with impact metrics.");
    expect(result).toBe("You are a coach.");
  });
});
