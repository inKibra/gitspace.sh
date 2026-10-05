import type { Model, ModelThinkingLevel } from "@earendil-works/pi-ai";

// Pinned Cloud Code Assist catalog and wire metadata from OMP 18.2.11.
export type GoogleCatalogEntry = {
 model: Model<"google-gemini-cli">;
 requestModelId?: string;
 thinking?: { mode: string; efforts: string[]; requiresEffort?: boolean; suppressWhenOff?: boolean; effortRouting?: Partial<Record<ModelThinkingLevel, string>>; effortBudgets?: Partial<Record<ModelThinkingLevel, number>> };
 compat: { supportsFunctionPartId?: boolean; requiresSkipThoughtSignatureOnFirstFunctionCall?: boolean; dropUnsignedThinking?: boolean; ccaLegacyParametersSchema?: boolean; multimodalFunctionResponse?: boolean; flashStreamLeakWorkaround?: boolean; claudeThinkingBetaHeader?: boolean; antigravityClaudeToolMode?: boolean; stripImageInput?: boolean; streamFirstEventTimeoutMs?: number; thinkingLoopGuard?: string; antigravityUsageLabel?: string; requiresSkipThoughtSignature?: boolean };
};

export const googleCatalog: readonly GoogleCatalogEntry[] = [
  {
    "model": {
      "id": "gemini-2.0-flash",
      "name": "Gemini 2.0 Flash",
      "api": "google-gemini-cli",
      "provider": "google-gemini-cli",
      "baseUrl": "https://cloudcode-pa.googleapis.com",
      "reasoning": false,
      "input": [
        "text",
        "image"
      ],
      "cost": {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0
      },
      "contextWindow": 1048576,
      "maxTokens": 8192
    },
    "compat": {
      "supportsFunctionPartId": false,
      "requiresSkipThoughtSignature": false,
      "requiresSkipThoughtSignatureOnFirstFunctionCall": false,
      "dropUnsignedThinking": false,
      "ccaLegacyParametersSchema": false,
      "multimodalFunctionResponse": false,
      "flashStreamLeakWorkaround": true,
      "claudeThinkingBetaHeader": false,
      "antigravityClaudeToolMode": false,
      "stripImageInput": false,
      "streamFirstEventTimeoutMs": 60000,
      "thinkingLoopGuard": "gemini"
    }
  },
  {
    "model": {
      "id": "gemini-2.5-flash",
      "name": "Gemini 2.5 Flash",
      "api": "google-gemini-cli",
      "provider": "google-gemini-cli",
      "baseUrl": "https://cloudcode-pa.googleapis.com",
      "reasoning": true,
      "input": [
        "text",
        "image"
      ],
      "cost": {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0
      },
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "thinking": {
      "mode": "budget",
      "efforts": [
        "minimal",
        "low",
        "medium",
        "high"
      ],
      "effortRouting": {
        "off": "gemini-2.5-flash",
        "minimal": "gemini-2.5-flash-thinking",
        "low": "gemini-2.5-flash-thinking",
        "medium": "gemini-2.5-flash-thinking",
        "high": "gemini-2.5-flash-thinking"
      }
    },
    "compat": {
      "supportsFunctionPartId": false,
      "requiresSkipThoughtSignature": false,
      "requiresSkipThoughtSignatureOnFirstFunctionCall": false,
      "dropUnsignedThinking": false,
      "ccaLegacyParametersSchema": false,
      "multimodalFunctionResponse": false,
      "flashStreamLeakWorkaround": true,
      "claudeThinkingBetaHeader": false,
      "antigravityClaudeToolMode": false,
      "stripImageInput": false,
      "streamFirstEventTimeoutMs": 60000,
      "thinkingLoopGuard": "gemini"
    }
  },
  {
    "model": {
      "id": "gemini-2.5-pro",
      "name": "Gemini 2.5 Pro",
      "api": "google-gemini-cli",
      "provider": "google-gemini-cli",
      "baseUrl": "https://cloudcode-pa.googleapis.com",
      "reasoning": true,
      "input": [
        "text",
        "image"
      ],
      "cost": {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0
      },
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "thinking": {
      "mode": "budget",
      "efforts": [
        "minimal",
        "low",
        "medium",
        "high"
      ],
      "requiresEffort": true
    },
    "compat": {
      "supportsFunctionPartId": false,
      "requiresSkipThoughtSignature": false,
      "requiresSkipThoughtSignatureOnFirstFunctionCall": false,
      "dropUnsignedThinking": false,
      "ccaLegacyParametersSchema": false,
      "multimodalFunctionResponse": false,
      "flashStreamLeakWorkaround": false,
      "claudeThinkingBetaHeader": false,
      "antigravityClaudeToolMode": false,
      "stripImageInput": false,
      "thinkingLoopGuard": "gemini"
    }
  },
  {
    "model": {
      "id": "gemini-3-flash-preview",
      "name": "Gemini 3 Flash Preview",
      "api": "google-gemini-cli",
      "provider": "google-gemini-cli",
      "baseUrl": "https://cloudcode-pa.googleapis.com",
      "reasoning": true,
      "input": [
        "text",
        "image"
      ],
      "cost": {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0
      },
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "thinking": {
      "mode": "google-level",
      "efforts": [
        "minimal",
        "low",
        "medium",
        "high"
      ],
      "requiresEffort": true
    },
    "compat": {
      "supportsFunctionPartId": false,
      "requiresSkipThoughtSignature": false,
      "requiresSkipThoughtSignatureOnFirstFunctionCall": true,
      "dropUnsignedThinking": false,
      "ccaLegacyParametersSchema": false,
      "multimodalFunctionResponse": true,
      "flashStreamLeakWorkaround": true,
      "claudeThinkingBetaHeader": false,
      "antigravityClaudeToolMode": false,
      "stripImageInput": false,
      "streamFirstEventTimeoutMs": 60000,
      "thinkingLoopGuard": "gemini"
    }
  },
  {
    "model": {
      "id": "gemini-3-pro-preview",
      "name": "Gemini 3 Pro Preview",
      "api": "google-gemini-cli",
      "provider": "google-gemini-cli",
      "baseUrl": "https://cloudcode-pa.googleapis.com",
      "reasoning": true,
      "input": [
        "text",
        "image"
      ],
      "cost": {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0
      },
      "contextWindow": 1000000,
      "maxTokens": 64000
    },
    "thinking": {
      "mode": "google-level",
      "efforts": [
        "low",
        "high"
      ],
      "requiresEffort": true
    },
    "compat": {
      "supportsFunctionPartId": false,
      "requiresSkipThoughtSignature": false,
      "requiresSkipThoughtSignatureOnFirstFunctionCall": true,
      "dropUnsignedThinking": false,
      "ccaLegacyParametersSchema": false,
      "multimodalFunctionResponse": true,
      "flashStreamLeakWorkaround": false,
      "claudeThinkingBetaHeader": false,
      "antigravityClaudeToolMode": false,
      "stripImageInput": false,
      "thinkingLoopGuard": "gemini"
    }
  },
  {
    "model": {
      "id": "gemini-3.1-flash-lite-preview",
      "name": "Gemini 3.1 Flash Lite Preview",
      "api": "google-gemini-cli",
      "provider": "google-gemini-cli",
      "baseUrl": "https://cloudcode-pa.googleapis.com",
      "reasoning": true,
      "input": [
        "text",
        "image"
      ],
      "cost": {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0
      },
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "thinking": {
      "mode": "google-level",
      "efforts": [
        "minimal",
        "low",
        "medium",
        "high"
      ],
      "requiresEffort": true
    },
    "compat": {
      "supportsFunctionPartId": false,
      "requiresSkipThoughtSignature": false,
      "requiresSkipThoughtSignatureOnFirstFunctionCall": true,
      "dropUnsignedThinking": false,
      "ccaLegacyParametersSchema": false,
      "multimodalFunctionResponse": true,
      "flashStreamLeakWorkaround": false,
      "claudeThinkingBetaHeader": false,
      "antigravityClaudeToolMode": false,
      "stripImageInput": false,
      "thinkingLoopGuard": "gemini"
    }
  },
  {
    "model": {
      "id": "gemini-3.1-pro-preview",
      "name": "Gemini 3.1 Pro Preview",
      "api": "google-gemini-cli",
      "provider": "google-gemini-cli",
      "baseUrl": "https://cloudcode-pa.googleapis.com",
      "reasoning": true,
      "input": [
        "text",
        "image"
      ],
      "cost": {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0
      },
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "thinking": {
      "mode": "google-level",
      "efforts": [
        "low",
        "high"
      ],
      "requiresEffort": true
    },
    "compat": {
      "supportsFunctionPartId": false,
      "requiresSkipThoughtSignature": false,
      "requiresSkipThoughtSignatureOnFirstFunctionCall": true,
      "dropUnsignedThinking": false,
      "ccaLegacyParametersSchema": false,
      "multimodalFunctionResponse": true,
      "flashStreamLeakWorkaround": false,
      "claudeThinkingBetaHeader": false,
      "antigravityClaudeToolMode": false,
      "stripImageInput": false,
      "thinkingLoopGuard": "gemini"
    }
  },
  {
    "model": {
      "id": "claude-opus-4-5",
      "name": "Claude Opus 4.5",
      "api": "google-gemini-cli",
      "provider": "google-antigravity",
      "baseUrl": "https://daily-cloudcode-pa.googleapis.com",
      "reasoning": true,
      "input": [
        "text",
        "image"
      ],
      "cost": {
        "input": 5,
        "output": 25,
        "cacheRead": 0.5,
        "cacheWrite": 6.25
      },
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "requestModelId": "claude-opus-4-5-thinking",
    "thinking": {
      "mode": "budget",
      "efforts": [
        "minimal",
        "low",
        "medium",
        "high"
      ],
      "effortRouting": {
        "off": "claude-opus-4-5",
        "minimal": "claude-opus-4-5-thinking",
        "low": "claude-opus-4-5-thinking",
        "medium": "claude-opus-4-5-thinking",
        "high": "claude-opus-4-5-thinking"
      }
    },
    "compat": {
      "supportsFunctionPartId": true,
      "requiresSkipThoughtSignature": false,
      "requiresSkipThoughtSignatureOnFirstFunctionCall": false,
      "dropUnsignedThinking": true,
      "ccaLegacyParametersSchema": true,
      "multimodalFunctionResponse": false,
      "flashStreamLeakWorkaround": false,
      "claudeThinkingBetaHeader": true,
      "antigravityClaudeToolMode": true,
      "stripImageInput": false,
      "antigravityUsageLabel": "true"
    }
  },
  {
    "model": {
      "id": "claude-opus-4-6",
      "name": "Claude Opus 4.6",
      "api": "google-gemini-cli",
      "provider": "google-antigravity",
      "baseUrl": "https://daily-cloudcode-pa.googleapis.com",
      "reasoning": true,
      "input": [
        "text",
        "image"
      ],
      "cost": {
        "input": 5,
        "output": 25,
        "cacheRead": 0.5,
        "cacheWrite": 6.25
      },
      "contextWindow": 250000,
      "maxTokens": 64000
    },
    "requestModelId": "claude-opus-4-6-thinking",
    "thinking": {
      "mode": "budget",
      "efforts": [
        "minimal",
        "low",
        "medium",
        "high"
      ]
    },
    "compat": {
      "supportsFunctionPartId": true,
      "requiresSkipThoughtSignature": false,
      "requiresSkipThoughtSignatureOnFirstFunctionCall": false,
      "dropUnsignedThinking": true,
      "ccaLegacyParametersSchema": true,
      "multimodalFunctionResponse": false,
      "flashStreamLeakWorkaround": false,
      "claudeThinkingBetaHeader": true,
      "antigravityClaudeToolMode": true,
      "stripImageInput": false,
      "antigravityUsageLabel": "true"
    }
  },
  {
    "model": {
      "id": "claude-sonnet-4-5",
      "name": "Claude Sonnet 4.5",
      "api": "google-gemini-cli",
      "provider": "google-antigravity",
      "baseUrl": "https://daily-cloudcode-pa.googleapis.com",
      "reasoning": true,
      "input": [
        "text",
        "image"
      ],
      "cost": {
        "input": 3,
        "output": 15,
        "cacheRead": 0.3,
        "cacheWrite": 3.75
      },
      "contextWindow": 1000000,
      "maxTokens": 64000
    },
    "requestModelId": "claude-sonnet-4-5",
    "thinking": {
      "mode": "budget",
      "efforts": [
        "minimal",
        "low",
        "medium",
        "high"
      ],
      "effortRouting": {
        "off": "claude-sonnet-4-5",
        "minimal": "claude-sonnet-4-5-thinking",
        "low": "claude-sonnet-4-5-thinking",
        "medium": "claude-sonnet-4-5-thinking",
        "high": "claude-sonnet-4-5-thinking"
      }
    },
    "compat": {
      "supportsFunctionPartId": true,
      "requiresSkipThoughtSignature": false,
      "requiresSkipThoughtSignatureOnFirstFunctionCall": false,
      "dropUnsignedThinking": true,
      "ccaLegacyParametersSchema": true,
      "multimodalFunctionResponse": false,
      "flashStreamLeakWorkaround": false,
      "claudeThinkingBetaHeader": true,
      "antigravityClaudeToolMode": true,
      "stripImageInput": false,
      "antigravityUsageLabel": "true"
    }
  },
  {
    "model": {
      "id": "claude-sonnet-4-6",
      "name": "Claude Sonnet 4.6",
      "api": "google-gemini-cli",
      "provider": "google-antigravity",
      "baseUrl": "https://daily-cloudcode-pa.googleapis.com",
      "reasoning": true,
      "input": [
        "text",
        "image"
      ],
      "cost": {
        "input": 3,
        "output": 15,
        "cacheRead": 0.3,
        "cacheWrite": 3.75
      },
      "contextWindow": 250000,
      "maxTokens": 64000
    },
    "thinking": {
      "mode": "budget",
      "efforts": [
        "minimal",
        "low",
        "medium",
        "high"
      ]
    },
    "compat": {
      "supportsFunctionPartId": true,
      "requiresSkipThoughtSignature": false,
      "requiresSkipThoughtSignatureOnFirstFunctionCall": false,
      "dropUnsignedThinking": true,
      "ccaLegacyParametersSchema": true,
      "multimodalFunctionResponse": false,
      "flashStreamLeakWorkaround": false,
      "claudeThinkingBetaHeader": true,
      "antigravityClaudeToolMode": true,
      "stripImageInput": false,
      "antigravityUsageLabel": "true"
    }
  },
  {
    "model": {
      "id": "gemini-2.5-flash",
      "name": "Gemini 2.5 Flash",
      "api": "google-gemini-cli",
      "provider": "google-antigravity",
      "baseUrl": "https://daily-cloudcode-pa.googleapis.com",
      "reasoning": true,
      "input": [
        "text",
        "image"
      ],
      "cost": {
        "input": 0.3,
        "output": 2.5,
        "cacheRead": 0.03,
        "cacheWrite": 0
      },
      "contextWindow": 1048576,
      "maxTokens": 65535
    },
    "thinking": {
      "mode": "budget",
      "efforts": [
        "minimal",
        "low",
        "medium",
        "high"
      ],
      "effortRouting": {
        "off": "gemini-2.5-flash",
        "minimal": "gemini-2.5-flash-thinking",
        "low": "gemini-2.5-flash-thinking",
        "medium": "gemini-2.5-flash-thinking",
        "high": "gemini-2.5-flash-thinking"
      }
    },
    "compat": {
      "supportsFunctionPartId": false,
      "requiresSkipThoughtSignature": false,
      "requiresSkipThoughtSignatureOnFirstFunctionCall": false,
      "dropUnsignedThinking": false,
      "ccaLegacyParametersSchema": false,
      "multimodalFunctionResponse": false,
      "flashStreamLeakWorkaround": true,
      "claudeThinkingBetaHeader": false,
      "antigravityClaudeToolMode": false,
      "stripImageInput": false,
      "streamFirstEventTimeoutMs": 60000,
      "thinkingLoopGuard": "gemini"
    }
  },
  {
    "model": {
      "id": "gemini-2.5-flash-lite",
      "name": "Gemini 2.5 Flash-Lite",
      "api": "google-gemini-cli",
      "provider": "google-antigravity",
      "baseUrl": "https://daily-cloudcode-pa.googleapis.com",
      "reasoning": true,
      "input": [
        "text",
        "image"
      ],
      "cost": {
        "input": 0.1,
        "output": 0.4,
        "cacheRead": 0.01,
        "cacheWrite": 0
      },
      "contextWindow": 1048576,
      "maxTokens": 65535
    },
    "thinking": {
      "mode": "budget",
      "efforts": [
        "minimal",
        "low",
        "medium",
        "high"
      ]
    },
    "compat": {
      "supportsFunctionPartId": false,
      "requiresSkipThoughtSignature": false,
      "requiresSkipThoughtSignatureOnFirstFunctionCall": false,
      "dropUnsignedThinking": false,
      "ccaLegacyParametersSchema": false,
      "multimodalFunctionResponse": false,
      "flashStreamLeakWorkaround": false,
      "claudeThinkingBetaHeader": false,
      "antigravityClaudeToolMode": false,
      "stripImageInput": false,
      "thinkingLoopGuard": "gemini"
    }
  },
  {
    "model": {
      "id": "gemini-2.5-pro",
      "name": "Gemini 2.5 Pro",
      "api": "google-gemini-cli",
      "provider": "google-antigravity",
      "baseUrl": "https://daily-cloudcode-pa.googleapis.com",
      "reasoning": true,
      "input": [
        "text",
        "image"
      ],
      "cost": {
        "input": 1.25,
        "output": 10,
        "cacheRead": 0.125,
        "cacheWrite": 0
      },
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "thinking": {
      "mode": "budget",
      "efforts": [
        "minimal",
        "low",
        "medium",
        "high"
      ],
      "requiresEffort": true
    },
    "compat": {
      "supportsFunctionPartId": false,
      "requiresSkipThoughtSignature": false,
      "requiresSkipThoughtSignatureOnFirstFunctionCall": false,
      "dropUnsignedThinking": false,
      "ccaLegacyParametersSchema": false,
      "multimodalFunctionResponse": false,
      "flashStreamLeakWorkaround": false,
      "claudeThinkingBetaHeader": false,
      "antigravityClaudeToolMode": false,
      "stripImageInput": false,
      "thinkingLoopGuard": "gemini"
    }
  },
  {
    "model": {
      "id": "gemini-3-flash",
      "name": "Gemini 3 Flash",
      "api": "google-gemini-cli",
      "provider": "google-antigravity",
      "baseUrl": "https://daily-cloudcode-pa.googleapis.com",
      "reasoning": true,
      "input": [
        "text",
        "image"
      ],
      "cost": {
        "input": 0.5,
        "output": 3,
        "cacheRead": 0.05,
        "cacheWrite": 0
      },
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "requestModelId": "gemini-3.5-flash-extra-low",
    "thinking": {
      "mode": "budget",
      "efforts": [
        "minimal",
        "low",
        "medium",
        "high"
      ],
      "effortBudgets": {
        "minimal": 1000,
        "low": 1000,
        "medium": 4000,
        "high": 10000
      },
      "effortRouting": {
        "off": "gemini-3.5-flash-extra-low",
        "minimal": "gemini-3.5-flash-extra-low",
        "low": "gemini-3.5-flash-extra-low",
        "medium": "gemini-3.5-flash-low",
        "high": "gemini-3-flash-agent"
      },
      "suppressWhenOff": true,
      "requiresEffort": true
    },
    "compat": {
      "supportsFunctionPartId": false,
      "requiresSkipThoughtSignature": false,
      "requiresSkipThoughtSignatureOnFirstFunctionCall": true,
      "dropUnsignedThinking": false,
      "ccaLegacyParametersSchema": false,
      "multimodalFunctionResponse": true,
      "flashStreamLeakWorkaround": true,
      "claudeThinkingBetaHeader": false,
      "antigravityClaudeToolMode": false,
      "stripImageInput": false,
      "streamFirstEventTimeoutMs": 60000,
      "thinkingLoopGuard": "gemini"
    }
  },
  {
    "model": {
      "id": "gemini-3-pro",
      "name": "Gemini 3 Pro",
      "api": "google-gemini-cli",
      "provider": "google-antigravity",
      "baseUrl": "https://daily-cloudcode-pa.googleapis.com",
      "reasoning": true,
      "input": [
        "text",
        "image"
      ],
      "cost": {
        "input": 2,
        "output": 12,
        "cacheRead": 0.2,
        "cacheWrite": 0
      },
      "contextWindow": 1048576,
      "maxTokens": 65535
    },
    "requestModelId": "gemini-3-pro-low",
    "thinking": {
      "mode": "google-level",
      "efforts": [
        "low",
        "high"
      ],
      "effortRouting": {
        "off": "gemini-3-pro-low",
        "low": "gemini-3-pro-low",
        "high": "gemini-3-pro-high"
      },
      "suppressWhenOff": true,
      "requiresEffort": true
    },
    "compat": {
      "supportsFunctionPartId": false,
      "requiresSkipThoughtSignature": false,
      "requiresSkipThoughtSignatureOnFirstFunctionCall": true,
      "dropUnsignedThinking": false,
      "ccaLegacyParametersSchema": false,
      "multimodalFunctionResponse": true,
      "flashStreamLeakWorkaround": false,
      "claudeThinkingBetaHeader": false,
      "antigravityClaudeToolMode": false,
      "stripImageInput": false,
      "thinkingLoopGuard": "gemini"
    }
  },
  {
    "model": {
      "id": "gemini-3-pro-image",
      "name": "Nano Banana Pro",
      "api": "google-gemini-cli",
      "provider": "google-antigravity",
      "baseUrl": "https://daily-cloudcode-pa.googleapis.com",
      "reasoning": false,
      "input": [
        "text",
        "image"
      ],
      "cost": {
        "input": 2,
        "output": 120,
        "cacheRead": 0,
        "cacheWrite": 0
      },
      "contextWindow": 131072,
      "maxTokens": 32768
    },
    "compat": {
      "supportsFunctionPartId": false,
      "requiresSkipThoughtSignature": false,
      "requiresSkipThoughtSignatureOnFirstFunctionCall": true,
      "dropUnsignedThinking": false,
      "ccaLegacyParametersSchema": false,
      "multimodalFunctionResponse": true,
      "flashStreamLeakWorkaround": false,
      "claudeThinkingBetaHeader": false,
      "antigravityClaudeToolMode": false,
      "stripImageInput": false,
      "thinkingLoopGuard": "gemini"
    }
  },
  {
    "model": {
      "id": "gemini-3.1-flash-image",
      "name": "Nano Banana 2",
      "api": "google-gemini-cli",
      "provider": "google-antigravity",
      "baseUrl": "https://daily-cloudcode-pa.googleapis.com",
      "reasoning": false,
      "input": [
        "text",
        "image"
      ],
      "cost": {
        "input": 0.5,
        "output": 60,
        "cacheRead": 0,
        "cacheWrite": 0
      },
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "compat": {
      "supportsFunctionPartId": false,
      "requiresSkipThoughtSignature": false,
      "requiresSkipThoughtSignatureOnFirstFunctionCall": true,
      "dropUnsignedThinking": false,
      "ccaLegacyParametersSchema": false,
      "multimodalFunctionResponse": true,
      "flashStreamLeakWorkaround": true,
      "claudeThinkingBetaHeader": false,
      "antigravityClaudeToolMode": false,
      "stripImageInput": false,
      "streamFirstEventTimeoutMs": 60000,
      "thinkingLoopGuard": "gemini"
    }
  },
  {
    "model": {
      "id": "gemini-3.1-flash-lite",
      "name": "Gemini 3.1 Flash Lite",
      "api": "google-gemini-cli",
      "provider": "google-antigravity",
      "baseUrl": "https://daily-cloudcode-pa.googleapis.com",
      "reasoning": true,
      "input": [
        "text",
        "image"
      ],
      "cost": {
        "input": 0.25,
        "output": 1.5,
        "cacheRead": 0.025,
        "cacheWrite": 0
      },
      "contextWindow": 1048576,
      "maxTokens": 65535
    },
    "thinking": {
      "mode": "google-level",
      "efforts": [
        "minimal",
        "low",
        "medium",
        "high"
      ],
      "requiresEffort": true
    },
    "compat": {
      "supportsFunctionPartId": false,
      "requiresSkipThoughtSignature": false,
      "requiresSkipThoughtSignatureOnFirstFunctionCall": true,
      "dropUnsignedThinking": false,
      "ccaLegacyParametersSchema": false,
      "multimodalFunctionResponse": true,
      "flashStreamLeakWorkaround": false,
      "claudeThinkingBetaHeader": false,
      "antigravityClaudeToolMode": false,
      "stripImageInput": false,
      "thinkingLoopGuard": "gemini"
    }
  },
  {
    "model": {
      "id": "gemini-3.1-pro",
      "name": "Gemini 3.1 Pro Preview",
      "api": "google-gemini-cli",
      "provider": "google-antigravity",
      "baseUrl": "https://daily-cloudcode-pa.googleapis.com",
      "reasoning": true,
      "input": [
        "text",
        "image"
      ],
      "cost": {
        "input": 2,
        "output": 12,
        "cacheRead": 0.2,
        "cacheWrite": 0
      },
      "contextWindow": 1048576,
      "maxTokens": 65535
    },
    "requestModelId": "gemini-3.1-pro-low",
    "thinking": {
      "mode": "budget",
      "efforts": [
        "low",
        "high"
      ],
      "effortBudgets": {
        "low": 1001,
        "high": 10001
      },
      "effortRouting": {
        "off": "gemini-3.1-pro-low",
        "low": "gemini-3.1-pro-low",
        "high": "gemini-pro-agent"
      },
      "suppressWhenOff": true,
      "requiresEffort": true
    },
    "compat": {
      "supportsFunctionPartId": false,
      "requiresSkipThoughtSignature": false,
      "requiresSkipThoughtSignatureOnFirstFunctionCall": true,
      "dropUnsignedThinking": false,
      "ccaLegacyParametersSchema": false,
      "multimodalFunctionResponse": true,
      "flashStreamLeakWorkaround": false,
      "claudeThinkingBetaHeader": false,
      "antigravityClaudeToolMode": false,
      "stripImageInput": false,
      "thinkingLoopGuard": "gemini"
    }
  },
  {
    "model": {
      "id": "gemini-3.5-flash",
      "name": "Gemini 3.5 Flash",
      "api": "google-gemini-cli",
      "provider": "google-antigravity",
      "baseUrl": "https://daily-cloudcode-pa.googleapis.com",
      "reasoning": true,
      "input": [
        "text",
        "image"
      ],
      "cost": {
        "input": 1.5,
        "output": 9,
        "cacheRead": 0.15,
        "cacheWrite": 0
      },
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "requestModelId": "gemini-3.5-flash-extra-low",
    "thinking": {
      "mode": "budget",
      "efforts": [
        "minimal",
        "low",
        "medium",
        "high"
      ],
      "effortBudgets": {
        "minimal": 1000,
        "low": 1000,
        "medium": 4000,
        "high": 10000
      },
      "effortRouting": {
        "off": "gemini-3.5-flash-extra-low",
        "minimal": "gemini-3.5-flash-extra-low",
        "low": "gemini-3.5-flash-extra-low",
        "medium": "gemini-3.5-flash-low",
        "high": "gemini-3-flash-agent"
      },
      "suppressWhenOff": true,
      "requiresEffort": true
    },
    "compat": {
      "supportsFunctionPartId": false,
      "requiresSkipThoughtSignature": false,
      "requiresSkipThoughtSignatureOnFirstFunctionCall": true,
      "dropUnsignedThinking": false,
      "ccaLegacyParametersSchema": false,
      "multimodalFunctionResponse": true,
      "flashStreamLeakWorkaround": true,
      "claudeThinkingBetaHeader": false,
      "antigravityClaudeToolMode": false,
      "stripImageInput": false,
      "streamFirstEventTimeoutMs": 60000,
      "thinkingLoopGuard": "gemini"
    }
  },
  {
    "model": {
      "id": "gemini-3.5-flash-lite",
      "name": "Gemini 3.5 Flash Lite",
      "api": "google-gemini-cli",
      "provider": "google-antigravity",
      "baseUrl": "https://daily-cloudcode-pa.googleapis.com",
      "reasoning": true,
      "input": [
        "text",
        "image"
      ],
      "cost": {
        "input": 0.3,
        "output": 2.5,
        "cacheRead": 0.03,
        "cacheWrite": 0
      },
      "contextWindow": 1048576,
      "maxTokens": 65535
    },
    "thinking": {
      "mode": "google-level",
      "efforts": [
        "minimal",
        "low",
        "medium",
        "high"
      ],
      "requiresEffort": true
    },
    "compat": {
      "supportsFunctionPartId": false,
      "requiresSkipThoughtSignature": false,
      "requiresSkipThoughtSignatureOnFirstFunctionCall": true,
      "dropUnsignedThinking": false,
      "ccaLegacyParametersSchema": false,
      "multimodalFunctionResponse": true,
      "flashStreamLeakWorkaround": false,
      "claudeThinkingBetaHeader": false,
      "antigravityClaudeToolMode": false,
      "stripImageInput": false,
      "thinkingLoopGuard": "gemini"
    }
  },
  {
    "model": {
      "id": "gemini-3.6-flash",
      "name": "Gemini 3.6 Flash",
      "api": "google-gemini-cli",
      "provider": "google-antigravity",
      "baseUrl": "https://daily-cloudcode-pa.googleapis.com",
      "reasoning": true,
      "input": [
        "text",
        "image"
      ],
      "cost": {
        "input": 0.75,
        "output": 3.75,
        "cacheRead": 0.075,
        "cacheWrite": 0
      },
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "requestModelId": "gemini-3.6-flash-low",
    "thinking": {
      "mode": "google-level",
      "efforts": [
        "minimal",
        "low",
        "medium",
        "high"
      ],
      "requiresEffort": true,
      "effortRouting": {
        "minimal": "gemini-3.6-flash-low",
        "low": "gemini-3.6-flash-low",
        "medium": "gemini-3.6-flash-medium",
        "high": "gemini-3.6-flash-high"
      }
    },
    "compat": {
      "supportsFunctionPartId": false,
      "requiresSkipThoughtSignature": false,
      "requiresSkipThoughtSignatureOnFirstFunctionCall": true,
      "dropUnsignedThinking": false,
      "ccaLegacyParametersSchema": false,
      "multimodalFunctionResponse": true,
      "flashStreamLeakWorkaround": true,
      "claudeThinkingBetaHeader": false,
      "antigravityClaudeToolMode": false,
      "stripImageInput": false,
      "streamFirstEventTimeoutMs": 60000,
      "thinkingLoopGuard": "gemini"
    }
  },
  {
    "model": {
      "id": "gemini-3.7-flash",
      "name": "Gemini 3.7 Flash",
      "api": "google-gemini-cli",
      "provider": "google-antigravity",
      "baseUrl": "https://daily-cloudcode-pa.googleapis.com",
      "reasoning": true,
      "input": [
        "text",
        "image"
      ],
      "cost": {
        "input": 0.75,
        "output": 3.75,
        "cacheRead": 0.075,
        "cacheWrite": 0
      },
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "requestModelId": "gemini-3.7-flash-low",
    "thinking": {
      "mode": "google-level",
      "efforts": [
        "minimal",
        "low",
        "medium",
        "high"
      ],
      "requiresEffort": true,
      "effortRouting": {
        "minimal": "gemini-3.7-flash-low",
        "low": "gemini-3.7-flash-low",
        "medium": "gemini-3.7-flash-medium",
        "high": "gemini-3.7-flash-high"
      }
    },
    "compat": {
      "supportsFunctionPartId": false,
      "requiresSkipThoughtSignature": false,
      "requiresSkipThoughtSignatureOnFirstFunctionCall": true,
      "dropUnsignedThinking": false,
      "ccaLegacyParametersSchema": false,
      "multimodalFunctionResponse": true,
      "flashStreamLeakWorkaround": true,
      "claudeThinkingBetaHeader": false,
      "antigravityClaudeToolMode": false,
      "stripImageInput": false,
      "streamFirstEventTimeoutMs": 60000,
      "thinkingLoopGuard": "gemini"
    }
  },
  {
    "model": {
      "id": "gemini-3.8-flash",
      "name": "Gemini 3.8 Flash",
      "api": "google-gemini-cli",
      "provider": "google-antigravity",
      "baseUrl": "https://daily-cloudcode-pa.googleapis.com",
      "reasoning": true,
      "input": [
        "text",
        "image"
      ],
      "cost": {
        "input": 0.75,
        "output": 3.75,
        "cacheRead": 0.075,
        "cacheWrite": 0
      },
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "requestModelId": "gemini-3.8-flash-low",
    "thinking": {
      "mode": "google-level",
      "efforts": [
        "minimal",
        "low",
        "medium",
        "high"
      ],
      "requiresEffort": true,
      "effortRouting": {
        "minimal": "gemini-3.8-flash-low",
        "low": "gemini-3.8-flash-low",
        "medium": "gemini-3.8-flash-medium",
        "high": "gemini-3.8-flash-high"
      }
    },
    "compat": {
      "supportsFunctionPartId": false,
      "requiresSkipThoughtSignature": false,
      "requiresSkipThoughtSignatureOnFirstFunctionCall": true,
      "dropUnsignedThinking": false,
      "ccaLegacyParametersSchema": false,
      "multimodalFunctionResponse": true,
      "flashStreamLeakWorkaround": true,
      "claudeThinkingBetaHeader": false,
      "antigravityClaudeToolMode": false,
      "stripImageInput": false,
      "streamFirstEventTimeoutMs": 60000,
      "thinkingLoopGuard": "gemini"
    }
  },
  {
    "model": {
      "id": "gpt-oss-120b",
      "name": "GPT OSS 120B",
      "api": "google-gemini-cli",
      "provider": "google-antigravity",
      "baseUrl": "https://daily-cloudcode-pa.googleapis.com",
      "reasoning": true,
      "input": [
        "text"
      ],
      "cost": {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0
      },
      "contextWindow": 131072,
      "maxTokens": 32768
    },
    "requestModelId": "gpt-oss-120b-medium",
    "thinking": {
      "mode": "budget",
      "efforts": [
        "minimal",
        "low",
        "medium",
        "high"
      ]
    },
    "compat": {
      "supportsFunctionPartId": true,
      "requiresSkipThoughtSignature": false,
      "requiresSkipThoughtSignatureOnFirstFunctionCall": false,
      "dropUnsignedThinking": false,
      "ccaLegacyParametersSchema": false,
      "multimodalFunctionResponse": false,
      "flashStreamLeakWorkaround": false,
      "claudeThinkingBetaHeader": false,
      "antigravityClaudeToolMode": false,
      "stripImageInput": false
    }
  },
  {
    "model": {
      "id": "tab_flash_lite_preview",
      "name": "tab_flash_lite_preview",
      "api": "google-gemini-cli",
      "provider": "google-antigravity",
      "baseUrl": "https://daily-cloudcode-pa.googleapis.com",
      "reasoning": false,
      "input": [
        "text"
      ],
      "cost": {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0
      },
      "contextWindow": 16384,
      "maxTokens": 4096
    },
    "compat": {
      "supportsFunctionPartId": false,
      "requiresSkipThoughtSignature": false,
      "requiresSkipThoughtSignatureOnFirstFunctionCall": false,
      "dropUnsignedThinking": false,
      "ccaLegacyParametersSchema": false,
      "multimodalFunctionResponse": false,
      "flashStreamLeakWorkaround": false,
      "claudeThinkingBetaHeader": false,
      "antigravityClaudeToolMode": false,
      "stripImageInput": false
    }
  },
  {
    "model": {
      "id": "tab_jump_flash_lite_preview",
      "name": "tab_jump_flash_lite_preview",
      "api": "google-gemini-cli",
      "provider": "google-antigravity",
      "baseUrl": "https://daily-cloudcode-pa.googleapis.com",
      "reasoning": false,
      "input": [
        "text"
      ],
      "cost": {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0
      },
      "contextWindow": 16384,
      "maxTokens": 4096
    },
    "compat": {
      "supportsFunctionPartId": false,
      "requiresSkipThoughtSignature": false,
      "requiresSkipThoughtSignatureOnFirstFunctionCall": false,
      "dropUnsignedThinking": false,
      "ccaLegacyParametersSchema": false,
      "multimodalFunctionResponse": false,
      "flashStreamLeakWorkaround": false,
      "claudeThinkingBetaHeader": false,
      "antigravityClaudeToolMode": false,
      "stripImageInput": false
    }
  }
];
