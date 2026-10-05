// Bundled Cursor catalog from @oh-my-pi/pi-catalog 18.2.11 (MIT).
/*
MIT License

Copyright (c) 2025-2026 Can Bölük
Copyright (c) 2026 Stencil Labs, Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/
import type { Model } from "@earendil-works/pi-ai";

export type CursorCatalogEntry = {
  model: Model<"cursor-agent">;
  maxMode: boolean;
  maxModeRoutes: Record<string, boolean>;
  requestModelId: string;
  modelClass: string;
  family: string;
};

export const cursorCatalog: readonly CursorCatalogEntry[] = [
  {
    "model": {
      "id": "claude-4-sonnet",
      "name": "Claude Sonnet 4",
      "api": "cursor-agent",
      "provider": "cursor",
      "baseUrl": "https://api2.cursor.sh",
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
      "contextWindow": 200000,
      "maxTokens": 64000,
      "thinkingLevelMap": {
        "off": "claude-4-sonnet",
        "minimal": "claude-4-sonnet-thinking",
        "low": "claude-4-sonnet-thinking",
        "medium": "claude-4-sonnet-thinking",
        "high": "claude-4-sonnet-thinking"
      }
    },
    "maxMode": false,
    "maxModeRoutes": {
      "claude-4-sonnet-thinking": false
    },
    "requestModelId": "claude-4-sonnet",
    "modelClass": "anthropic",
    "family": "sonnet"
  },
  {
    "model": {
      "id": "claude-4.5-opus-high",
      "name": "Claude Opus 4.5",
      "api": "cursor-agent",
      "provider": "cursor",
      "baseUrl": "https://api2.cursor.sh",
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
      "contextWindow": 200000,
      "maxTokens": 64000,
      "thinkingLevelMap": {
        "off": "claude-4.5-opus-high",
        "minimal": "claude-4.5-opus-high-thinking",
        "low": "claude-4.5-opus-high-thinking",
        "medium": "claude-4.5-opus-high-thinking",
        "high": "claude-4.5-opus-high-thinking"
      }
    },
    "maxMode": false,
    "maxModeRoutes": {
      "claude-4.5-opus-high-thinking": false
    },
    "requestModelId": "claude-4.5-opus-high",
    "modelClass": "anthropic",
    "family": "opus"
  },
  {
    "model": {
      "id": "claude-4.5-sonnet",
      "name": "Claude Sonnet 4.5",
      "api": "cursor-agent",
      "provider": "cursor",
      "baseUrl": "https://api2.cursor.sh",
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
      "contextWindow": 200000,
      "maxTokens": 64000,
      "thinkingLevelMap": {
        "off": "claude-4.5-sonnet",
        "minimal": "claude-4.5-sonnet-thinking",
        "low": "claude-4.5-sonnet-thinking",
        "medium": "claude-4.5-sonnet-thinking",
        "high": "claude-4.5-sonnet-thinking"
      }
    },
    "maxMode": false,
    "maxModeRoutes": {
      "claude-4.5-sonnet-thinking": false
    },
    "requestModelId": "claude-4.5-sonnet",
    "modelClass": "anthropic",
    "family": "sonnet"
  },
  {
    "model": {
      "id": "claude-4.6-opus-high",
      "name": "Claude Opus 4.6 1M",
      "api": "cursor-agent",
      "provider": "cursor",
      "baseUrl": "https://api2.cursor.sh",
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
      "contextWindow": 1000000,
      "maxTokens": 64000,
      "thinkingLevelMap": {
        "off": "claude-4.6-opus-high",
        "minimal": "claude-4.6-opus-high-thinking",
        "low": "claude-4.6-opus-high-thinking",
        "medium": "claude-4.6-opus-high-thinking",
        "high": "claude-4.6-opus-high-thinking"
      }
    },
    "maxMode": false,
    "maxModeRoutes": {
      "claude-4.6-opus-high-thinking": false
    },
    "requestModelId": "claude-4.6-opus-high",
    "modelClass": "anthropic",
    "family": "opus"
  },
  {
    "model": {
      "id": "claude-4.6-opus-max",
      "name": "Claude Opus 4.6 1M Max",
      "api": "cursor-agent",
      "provider": "cursor",
      "baseUrl": "https://api2.cursor.sh",
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
      "maxTokens": 64000,
      "thinkingLevelMap": {
        "off": "claude-4.6-opus-max",
        "minimal": "claude-4.6-opus-max-thinking",
        "low": "claude-4.6-opus-max-thinking",
        "medium": "claude-4.6-opus-max-thinking",
        "high": "claude-4.6-opus-max-thinking"
      }
    },
    "maxMode": false,
    "maxModeRoutes": {
      "claude-4.6-opus-max-thinking": false
    },
    "requestModelId": "claude-4.6-opus-max",
    "modelClass": "anthropic",
    "family": "opus"
  },
  {
    "model": {
      "id": "claude-4.6-sonnet-medium",
      "name": "Claude Sonnet 4.6 1M",
      "api": "cursor-agent",
      "provider": "cursor",
      "baseUrl": "https://api2.cursor.sh",
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
      "contextWindow": 1000000,
      "maxTokens": 64000,
      "thinkingLevelMap": {
        "off": "claude-4.6-sonnet-medium",
        "minimal": "claude-4.6-sonnet-medium-thinking",
        "low": "claude-4.6-sonnet-medium-thinking",
        "medium": "claude-4.6-sonnet-medium-thinking",
        "high": "claude-4.6-sonnet-medium-thinking"
      }
    },
    "maxMode": false,
    "maxModeRoutes": {
      "claude-4.6-sonnet-medium-thinking": false
    },
    "requestModelId": "claude-4.6-sonnet-medium",
    "modelClass": "anthropic",
    "family": "sonnet"
  },
  {
    "model": {
      "id": "claude-fable-5-1-high",
      "name": "Claude Fable 5.1 1M (NO ZDR)",
      "api": "cursor-agent",
      "provider": "cursor",
      "baseUrl": "https://api2.cursor.sh",
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
      "maxTokens": 64000,
      "thinkingLevelMap": {
        "off": "claude-fable-5-1-high",
        "minimal": "claude-fable-5-1-thinking-high",
        "low": "claude-fable-5-1-thinking-high",
        "medium": "claude-fable-5-1-thinking-high",
        "high": "claude-fable-5-1-thinking-high"
      }
    },
    "maxMode": false,
    "maxModeRoutes": {
      "claude-fable-5-1-thinking-high": false
    },
    "requestModelId": "claude-fable-5-1-high",
    "modelClass": "anthropic",
    "family": "fable"
  },
  {
    "model": {
      "id": "claude-fable-5-1-low",
      "name": "Claude Fable 5.1 1M Low (NO ZDR)",
      "api": "cursor-agent",
      "provider": "cursor",
      "baseUrl": "https://api2.cursor.sh",
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
      "maxTokens": 64000,
      "thinkingLevelMap": {
        "off": "claude-fable-5-1-low",
        "minimal": "claude-fable-5-1-thinking-low",
        "low": "claude-fable-5-1-thinking-low",
        "medium": "claude-fable-5-1-thinking-low",
        "high": "claude-fable-5-1-thinking-low"
      }
    },
    "maxMode": false,
    "maxModeRoutes": {
      "claude-fable-5-1-thinking-low": false
    },
    "requestModelId": "claude-fable-5-1-low",
    "modelClass": "anthropic",
    "family": "fable"
  },
  {
    "model": {
      "id": "claude-fable-5-1-max",
      "name": "Claude Fable 5.1 1M Max (NO ZDR)",
      "api": "cursor-agent",
      "provider": "cursor",
      "baseUrl": "https://api2.cursor.sh",
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
      "maxTokens": 64000,
      "thinkingLevelMap": {
        "off": "claude-fable-5-1-max",
        "minimal": "claude-fable-5-1-thinking-max",
        "low": "claude-fable-5-1-thinking-max",
        "medium": "claude-fable-5-1-thinking-max",
        "high": "claude-fable-5-1-thinking-max"
      }
    },
    "maxMode": false,
    "maxModeRoutes": {
      "claude-fable-5-1-thinking-max": false
    },
    "requestModelId": "claude-fable-5-1-max",
    "modelClass": "anthropic",
    "family": "fable"
  },
  {
    "model": {
      "id": "claude-fable-5-1-medium",
      "name": "Claude Fable 5.1 1M Medium (NO ZDR)",
      "api": "cursor-agent",
      "provider": "cursor",
      "baseUrl": "https://api2.cursor.sh",
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
      "maxTokens": 64000,
      "thinkingLevelMap": {
        "off": "claude-fable-5-1-medium",
        "minimal": "claude-fable-5-1-thinking-medium",
        "low": "claude-fable-5-1-thinking-medium",
        "medium": "claude-fable-5-1-thinking-medium",
        "high": "claude-fable-5-1-thinking-medium"
      }
    },
    "maxMode": false,
    "maxModeRoutes": {
      "claude-fable-5-1-thinking-medium": false
    },
    "requestModelId": "claude-fable-5-1-medium",
    "modelClass": "anthropic",
    "family": "fable"
  },
  {
    "model": {
      "id": "claude-fable-5-1-xhigh",
      "name": "Claude Fable 5.1 1M Extra High (NO ZDR)",
      "api": "cursor-agent",
      "provider": "cursor",
      "baseUrl": "https://api2.cursor.sh",
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
      "maxTokens": 64000,
      "thinkingLevelMap": {
        "off": "claude-fable-5-1-xhigh",
        "minimal": "claude-fable-5-1-thinking-xhigh",
        "low": "claude-fable-5-1-thinking-xhigh",
        "medium": "claude-fable-5-1-thinking-xhigh",
        "high": "claude-fable-5-1-thinking-xhigh"
      }
    },
    "maxMode": false,
    "maxModeRoutes": {
      "claude-fable-5-1-thinking-xhigh": false
    },
    "requestModelId": "claude-fable-5-1-xhigh",
    "modelClass": "anthropic",
    "family": "fable"
  },
  {
    "model": {
      "id": "claude-fable-5-high",
      "name": "Claude Fable 5 1M (NO ZDR)",
      "api": "cursor-agent",
      "provider": "cursor",
      "baseUrl": "https://api2.cursor.sh",
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
      "maxTokens": 64000,
      "thinkingLevelMap": {
        "off": "claude-fable-5-high",
        "minimal": "claude-fable-5-thinking-high",
        "low": "claude-fable-5-thinking-high",
        "medium": "claude-fable-5-thinking-high",
        "high": "claude-fable-5-thinking-high"
      }
    },
    "maxMode": false,
    "maxModeRoutes": {
      "claude-fable-5-thinking-high": false
    },
    "requestModelId": "claude-fable-5-high",
    "modelClass": "anthropic",
    "family": "fable"
  },
  {
    "model": {
      "id": "claude-fable-5-low",
      "name": "Claude Fable 5 1M Low (NO ZDR)",
      "api": "cursor-agent",
      "provider": "cursor",
      "baseUrl": "https://api2.cursor.sh",
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
      "maxTokens": 64000,
      "thinkingLevelMap": {
        "off": "claude-fable-5-low",
        "minimal": "claude-fable-5-thinking-low",
        "low": "claude-fable-5-thinking-low",
        "medium": "claude-fable-5-thinking-low",
        "high": "claude-fable-5-thinking-low"
      }
    },
    "maxMode": false,
    "maxModeRoutes": {
      "claude-fable-5-thinking-low": false
    },
    "requestModelId": "claude-fable-5-low",
    "modelClass": "anthropic",
    "family": "fable"
  },
  {
    "model": {
      "id": "claude-fable-5-max",
      "name": "Claude Fable 5 1M Max (NO ZDR)",
      "api": "cursor-agent",
      "provider": "cursor",
      "baseUrl": "https://api2.cursor.sh",
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
      "maxTokens": 64000,
      "thinkingLevelMap": {
        "off": "claude-fable-5-max",
        "minimal": "claude-fable-5-thinking-max",
        "low": "claude-fable-5-thinking-max",
        "medium": "claude-fable-5-thinking-max",
        "high": "claude-fable-5-thinking-max"
      }
    },
    "maxMode": false,
    "maxModeRoutes": {
      "claude-fable-5-thinking-max": false
    },
    "requestModelId": "claude-fable-5-max",
    "modelClass": "anthropic",
    "family": "fable"
  },
  {
    "model": {
      "id": "claude-fable-5-medium",
      "name": "Claude Fable 5 1M Medium (NO ZDR)",
      "api": "cursor-agent",
      "provider": "cursor",
      "baseUrl": "https://api2.cursor.sh",
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
      "maxTokens": 64000,
      "thinkingLevelMap": {
        "off": "claude-fable-5-medium",
        "minimal": "claude-fable-5-thinking-medium",
        "low": "claude-fable-5-thinking-medium",
        "medium": "claude-fable-5-thinking-medium",
        "high": "claude-fable-5-thinking-medium"
      }
    },
    "maxMode": false,
    "maxModeRoutes": {
      "claude-fable-5-thinking-medium": false
    },
    "requestModelId": "claude-fable-5-medium",
    "modelClass": "anthropic",
    "family": "fable"
  },
  {
    "model": {
      "id": "claude-fable-5-xhigh",
      "name": "Claude Fable 5 1M Extra High (NO ZDR)",
      "api": "cursor-agent",
      "provider": "cursor",
      "baseUrl": "https://api2.cursor.sh",
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
      "maxTokens": 64000,
      "thinkingLevelMap": {
        "off": "claude-fable-5-xhigh",
        "minimal": "claude-fable-5-thinking-xhigh",
        "low": "claude-fable-5-thinking-xhigh",
        "medium": "claude-fable-5-thinking-xhigh",
        "high": "claude-fable-5-thinking-xhigh"
      }
    },
    "maxMode": false,
    "maxModeRoutes": {
      "claude-fable-5-thinking-xhigh": false
    },
    "requestModelId": "claude-fable-5-xhigh",
    "modelClass": "anthropic",
    "family": "fable"
  },
  {
    "model": {
      "id": "claude-opus-4-7-high",
      "name": "Claude Opus 4.7 1M High",
      "api": "cursor-agent",
      "provider": "cursor",
      "baseUrl": "https://api2.cursor.sh",
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
      "maxTokens": 64000,
      "thinkingLevelMap": {
        "off": "claude-opus-4-7-high",
        "minimal": "claude-opus-4-7-thinking-high",
        "low": "claude-opus-4-7-thinking-high",
        "medium": "claude-opus-4-7-thinking-high",
        "high": "claude-opus-4-7-thinking-high"
      }
    },
    "maxMode": false,
    "maxModeRoutes": {
      "claude-opus-4-7-thinking-high": false
    },
    "requestModelId": "claude-opus-4-7-high",
    "modelClass": "anthropic",
    "family": "opus"
  },
  {
    "model": {
      "id": "claude-opus-4-7-high-fast",
      "name": "Claude Opus 4.7 1M High Fast",
      "api": "cursor-agent",
      "provider": "cursor",
      "baseUrl": "https://api2.cursor.sh",
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
      "maxTokens": 64000,
      "thinkingLevelMap": {
        "off": "claude-opus-4-7-high-fast",
        "minimal": "claude-opus-4-7-thinking-high-fast",
        "low": "claude-opus-4-7-thinking-high-fast",
        "medium": "claude-opus-4-7-thinking-high-fast",
        "high": "claude-opus-4-7-thinking-high-fast"
      }
    },
    "maxMode": true,
    "maxModeRoutes": {
      "claude-opus-4-7-thinking-high-fast": true
    },
    "requestModelId": "claude-opus-4-7-high-fast",
    "modelClass": "anthropic",
    "family": "opus"
  },
  {
    "model": {
      "id": "claude-opus-4-7-low",
      "name": "Claude Opus 4.7 1M Low",
      "api": "cursor-agent",
      "provider": "cursor",
      "baseUrl": "https://api2.cursor.sh",
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
      "maxTokens": 64000,
      "thinkingLevelMap": {
        "off": "claude-opus-4-7-low",
        "minimal": "claude-opus-4-7-thinking-low",
        "low": "claude-opus-4-7-thinking-low",
        "medium": "claude-opus-4-7-thinking-low",
        "high": "claude-opus-4-7-thinking-low"
      }
    },
    "maxMode": false,
    "maxModeRoutes": {
      "claude-opus-4-7-thinking-low": false
    },
    "requestModelId": "claude-opus-4-7-low",
    "modelClass": "anthropic",
    "family": "opus"
  },
  {
    "model": {
      "id": "claude-opus-4-7-low-fast",
      "name": "Claude Opus 4.7 1M Low Fast",
      "api": "cursor-agent",
      "provider": "cursor",
      "baseUrl": "https://api2.cursor.sh",
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
      "maxTokens": 64000,
      "thinkingLevelMap": {
        "off": "claude-opus-4-7-low-fast",
        "minimal": "claude-opus-4-7-thinking-low-fast",
        "low": "claude-opus-4-7-thinking-low-fast",
        "medium": "claude-opus-4-7-thinking-low-fast",
        "high": "claude-opus-4-7-thinking-low-fast"
      }
    },
    "maxMode": true,
    "maxModeRoutes": {
      "claude-opus-4-7-thinking-low-fast": true
    },
    "requestModelId": "claude-opus-4-7-low-fast",
    "modelClass": "anthropic",
    "family": "opus"
  },
  {
    "model": {
      "id": "claude-opus-4-7-max",
      "name": "Claude Opus 4.7 1M Max",
      "api": "cursor-agent",
      "provider": "cursor",
      "baseUrl": "https://api2.cursor.sh",
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
      "maxTokens": 64000,
      "thinkingLevelMap": {
        "off": "claude-opus-4-7-max",
        "minimal": "claude-opus-4-7-thinking-max",
        "low": "claude-opus-4-7-thinking-max",
        "medium": "claude-opus-4-7-thinking-max",
        "high": "claude-opus-4-7-thinking-max"
      }
    },
    "maxMode": false,
    "maxModeRoutes": {
      "claude-opus-4-7-thinking-max": false
    },
    "requestModelId": "claude-opus-4-7-max",
    "modelClass": "anthropic",
    "family": "opus"
  },
  {
    "model": {
      "id": "claude-opus-4-7-max-fast",
      "name": "Claude Opus 4.7 1M Max Fast",
      "api": "cursor-agent",
      "provider": "cursor",
      "baseUrl": "https://api2.cursor.sh",
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
      "maxTokens": 64000,
      "thinkingLevelMap": {
        "off": "claude-opus-4-7-max-fast",
        "minimal": "claude-opus-4-7-thinking-max-fast",
        "low": "claude-opus-4-7-thinking-max-fast",
        "medium": "claude-opus-4-7-thinking-max-fast",
        "high": "claude-opus-4-7-thinking-max-fast"
      }
    },
    "maxMode": true,
    "maxModeRoutes": {
      "claude-opus-4-7-thinking-max-fast": true
    },
    "requestModelId": "claude-opus-4-7-max-fast",
    "modelClass": "anthropic",
    "family": "opus"
  },
  {
    "model": {
      "id": "claude-opus-4-7-medium",
      "name": "Claude Opus 4.7 1M Medium",
      "api": "cursor-agent",
      "provider": "cursor",
      "baseUrl": "https://api2.cursor.sh",
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
      "maxTokens": 64000,
      "thinkingLevelMap": {
        "off": "claude-opus-4-7-medium",
        "minimal": "claude-opus-4-7-thinking-medium",
        "low": "claude-opus-4-7-thinking-medium",
        "medium": "claude-opus-4-7-thinking-medium",
        "high": "claude-opus-4-7-thinking-medium"
      }
    },
    "maxMode": false,
    "maxModeRoutes": {
      "claude-opus-4-7-thinking-medium": false
    },
    "requestModelId": "claude-opus-4-7-medium",
    "modelClass": "anthropic",
    "family": "opus"
  },
  {
    "model": {
      "id": "claude-opus-4-7-medium-fast",
      "name": "Claude Opus 4.7 1M Medium Fast",
      "api": "cursor-agent",
      "provider": "cursor",
      "baseUrl": "https://api2.cursor.sh",
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
      "maxTokens": 64000,
      "thinkingLevelMap": {
        "off": "claude-opus-4-7-medium-fast",
        "minimal": "claude-opus-4-7-thinking-medium-fast",
        "low": "claude-opus-4-7-thinking-medium-fast",
        "medium": "claude-opus-4-7-thinking-medium-fast",
        "high": "claude-opus-4-7-thinking-medium-fast"
      }
    },
    "maxMode": true,
    "maxModeRoutes": {
      "claude-opus-4-7-thinking-medium-fast": true
    },
    "requestModelId": "claude-opus-4-7-medium-fast",
    "modelClass": "anthropic",
    "family": "opus"
  },
  {
    "model": {
      "id": "claude-opus-4-7-xhigh",
      "name": "Claude Opus 4.7 1M",
      "api": "cursor-agent",
      "provider": "cursor",
      "baseUrl": "https://api2.cursor.sh",
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
      "maxTokens": 64000,
      "thinkingLevelMap": {
        "off": "claude-opus-4-7-xhigh",
        "minimal": "claude-opus-4-7-thinking-xhigh",
        "low": "claude-opus-4-7-thinking-xhigh",
        "medium": "claude-opus-4-7-thinking-xhigh",
        "high": "claude-opus-4-7-thinking-xhigh"
      }
    },
    "maxMode": false,
    "maxModeRoutes": {
      "claude-opus-4-7-thinking-xhigh": false
    },
    "requestModelId": "claude-opus-4-7-xhigh",
    "modelClass": "anthropic",
    "family": "opus"
  },
  {
    "model": {
      "id": "claude-opus-4-7-xhigh-fast",
      "name": "Claude Opus 4.7 1M Fast",
      "api": "cursor-agent",
      "provider": "cursor",
      "baseUrl": "https://api2.cursor.sh",
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
      "maxTokens": 64000,
      "thinkingLevelMap": {
        "off": "claude-opus-4-7-xhigh-fast",
        "minimal": "claude-opus-4-7-thinking-xhigh-fast",
        "low": "claude-opus-4-7-thinking-xhigh-fast",
        "medium": "claude-opus-4-7-thinking-xhigh-fast",
        "high": "claude-opus-4-7-thinking-xhigh-fast"
      }
    },
    "maxMode": true,
    "maxModeRoutes": {
      "claude-opus-4-7-thinking-xhigh-fast": true
    },
    "requestModelId": "claude-opus-4-7-xhigh-fast",
    "modelClass": "anthropic",
    "family": "opus"
  },
  {
    "model": {
      "id": "claude-opus-4-8-high",
      "name": "Claude Opus 4.8 1M",
      "api": "cursor-agent",
      "provider": "cursor",
      "baseUrl": "https://api2.cursor.sh",
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
      "maxTokens": 64000,
      "thinkingLevelMap": {
        "off": "claude-opus-4-8-high",
        "minimal": "claude-opus-4-8-thinking-high",
        "low": "claude-opus-4-8-thinking-high",
        "medium": "claude-opus-4-8-thinking-high",
        "high": "claude-opus-4-8-thinking-high"
      }
    },
    "maxMode": false,
    "maxModeRoutes": {
      "claude-opus-4-8-thinking-high": false
    },
    "requestModelId": "claude-opus-4-8-high",
    "modelClass": "anthropic",
    "family": "opus"
  },
  {
    "model": {
      "id": "claude-opus-4-8-high-fast",
      "name": "Claude Opus 4.8 1M Fast",
      "api": "cursor-agent",
      "provider": "cursor",
      "baseUrl": "https://api2.cursor.sh",
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
      "maxTokens": 64000,
      "thinkingLevelMap": {
        "off": "claude-opus-4-8-high-fast",
        "minimal": "claude-opus-4-8-thinking-high-fast",
        "low": "claude-opus-4-8-thinking-high-fast",
        "medium": "claude-opus-4-8-thinking-high-fast",
        "high": "claude-opus-4-8-thinking-high-fast"
      }
    },
    "maxMode": true,
    "maxModeRoutes": {
      "claude-opus-4-8-thinking-high-fast": true
    },
    "requestModelId": "claude-opus-4-8-high-fast",
    "modelClass": "anthropic",
    "family": "opus"
  },
  {
    "model": {
      "id": "claude-opus-4-8-low",
      "name": "Claude Opus 4.8 1M Low",
      "api": "cursor-agent",
      "provider": "cursor",
      "baseUrl": "https://api2.cursor.sh",
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
      "maxTokens": 64000,
      "thinkingLevelMap": {
        "off": "claude-opus-4-8-low",
        "minimal": "claude-opus-4-8-thinking-low",
        "low": "claude-opus-4-8-thinking-low",
        "medium": "claude-opus-4-8-thinking-low",
        "high": "claude-opus-4-8-thinking-low"
      }
    },
    "maxMode": false,
    "maxModeRoutes": {
      "claude-opus-4-8-thinking-low": false
    },
    "requestModelId": "claude-opus-4-8-low",
    "modelClass": "anthropic",
    "family": "opus"
  },
  {
    "model": {
      "id": "claude-opus-4-8-low-fast",
      "name": "Claude Opus 4.8 1M Low Fast",
      "api": "cursor-agent",
      "provider": "cursor",
      "baseUrl": "https://api2.cursor.sh",
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
      "maxTokens": 64000,
      "thinkingLevelMap": {
        "off": "claude-opus-4-8-low-fast",
        "minimal": "claude-opus-4-8-thinking-low-fast",
        "low": "claude-opus-4-8-thinking-low-fast",
        "medium": "claude-opus-4-8-thinking-low-fast",
        "high": "claude-opus-4-8-thinking-low-fast"
      }
    },
    "maxMode": true,
    "maxModeRoutes": {
      "claude-opus-4-8-thinking-low-fast": true
    },
    "requestModelId": "claude-opus-4-8-low-fast",
    "modelClass": "anthropic",
    "family": "opus"
  },
  {
    "model": {
      "id": "claude-opus-4-8-max",
      "name": "Claude Opus 4.8 1M Max",
      "api": "cursor-agent",
      "provider": "cursor",
      "baseUrl": "https://api2.cursor.sh",
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
      "maxTokens": 64000,
      "thinkingLevelMap": {
        "off": "claude-opus-4-8-max",
        "minimal": "claude-opus-4-8-thinking-max",
        "low": "claude-opus-4-8-thinking-max",
        "medium": "claude-opus-4-8-thinking-max",
        "high": "claude-opus-4-8-thinking-max"
      }
    },
    "maxMode": false,
    "maxModeRoutes": {
      "claude-opus-4-8-thinking-max": false
    },
    "requestModelId": "claude-opus-4-8-max",
    "modelClass": "anthropic",
    "family": "opus"
  },
  {
    "model": {
      "id": "claude-opus-4-8-max-fast",
      "name": "Claude Opus 4.8 1M Max Fast",
      "api": "cursor-agent",
      "provider": "cursor",
      "baseUrl": "https://api2.cursor.sh",
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
      "maxTokens": 64000,
      "thinkingLevelMap": {
        "off": "claude-opus-4-8-max-fast",
        "minimal": "claude-opus-4-8-thinking-max-fast",
        "low": "claude-opus-4-8-thinking-max-fast",
        "medium": "claude-opus-4-8-thinking-max-fast",
        "high": "claude-opus-4-8-thinking-max-fast"
      }
    },
    "maxMode": true,
    "maxModeRoutes": {
      "claude-opus-4-8-thinking-max-fast": true
    },
    "requestModelId": "claude-opus-4-8-max-fast",
    "modelClass": "anthropic",
    "family": "opus"
  },
  {
    "model": {
      "id": "claude-opus-4-8-medium",
      "name": "Claude Opus 4.8 1M Medium",
      "api": "cursor-agent",
      "provider": "cursor",
      "baseUrl": "https://api2.cursor.sh",
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
      "maxTokens": 64000,
      "thinkingLevelMap": {
        "off": "claude-opus-4-8-medium",
        "minimal": "claude-opus-4-8-thinking-medium",
        "low": "claude-opus-4-8-thinking-medium",
        "medium": "claude-opus-4-8-thinking-medium",
        "high": "claude-opus-4-8-thinking-medium"
      }
    },
    "maxMode": false,
    "maxModeRoutes": {
      "claude-opus-4-8-thinking-medium": false
    },
    "requestModelId": "claude-opus-4-8-medium",
    "modelClass": "anthropic",
    "family": "opus"
  },
  {
    "model": {
      "id": "claude-opus-4-8-medium-fast",
      "name": "Claude Opus 4.8 1M Medium Fast",
      "api": "cursor-agent",
      "provider": "cursor",
      "baseUrl": "https://api2.cursor.sh",
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
      "maxTokens": 64000,
      "thinkingLevelMap": {
        "off": "claude-opus-4-8-medium-fast",
        "minimal": "claude-opus-4-8-thinking-medium-fast",
        "low": "claude-opus-4-8-thinking-medium-fast",
        "medium": "claude-opus-4-8-thinking-medium-fast",
        "high": "claude-opus-4-8-thinking-medium-fast"
      }
    },
    "maxMode": true,
    "maxModeRoutes": {
      "claude-opus-4-8-thinking-medium-fast": true
    },
    "requestModelId": "claude-opus-4-8-medium-fast",
    "modelClass": "anthropic",
    "family": "opus"
  },
  {
    "model": {
      "id": "claude-opus-4-8-xhigh",
      "name": "Claude Opus 4.8 1M Extra High",
      "api": "cursor-agent",
      "provider": "cursor",
      "baseUrl": "https://api2.cursor.sh",
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
      "maxTokens": 64000,
      "thinkingLevelMap": {
        "off": "claude-opus-4-8-xhigh",
        "minimal": "claude-opus-4-8-thinking-xhigh",
        "low": "claude-opus-4-8-thinking-xhigh",
        "medium": "claude-opus-4-8-thinking-xhigh",
        "high": "claude-opus-4-8-thinking-xhigh"
      }
    },
    "maxMode": false,
    "maxModeRoutes": {
      "claude-opus-4-8-thinking-xhigh": false
    },
    "requestModelId": "claude-opus-4-8-xhigh",
    "modelClass": "anthropic",
    "family": "opus"
  },
  {
    "model": {
      "id": "claude-opus-4-8-xhigh-fast",
      "name": "Claude Opus 4.8 1M Extra High Fast",
      "api": "cursor-agent",
      "provider": "cursor",
      "baseUrl": "https://api2.cursor.sh",
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
      "maxTokens": 64000,
      "thinkingLevelMap": {
        "off": "claude-opus-4-8-xhigh-fast",
        "minimal": "claude-opus-4-8-thinking-xhigh-fast",
        "low": "claude-opus-4-8-thinking-xhigh-fast",
        "medium": "claude-opus-4-8-thinking-xhigh-fast",
        "high": "claude-opus-4-8-thinking-xhigh-fast"
      }
    },
    "maxMode": true,
    "maxModeRoutes": {
      "claude-opus-4-8-thinking-xhigh-fast": true
    },
    "requestModelId": "claude-opus-4-8-xhigh-fast",
    "modelClass": "anthropic",
    "family": "opus"
  },
  {
    "model": {
      "id": "claude-opus-5-5",
      "name": "Claude Opus 5.5",
      "api": "cursor-agent",
      "provider": "cursor",
      "baseUrl": "https://api2.cursor.sh",
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
      "maxTokens": 64000,
      "thinkingLevelMap": {
        "low": "claude-opus-5-5-low",
        "medium": "claude-opus-5-5-medium",
        "high": "claude-opus-5-5-high",
        "xhigh": "claude-opus-5-5-xhigh",
        "max": "claude-opus-5-5-max"
      }
    },
    "maxMode": false,
    "maxModeRoutes": {
      "claude-opus-5-5-low": false,
      "claude-opus-5-5-medium": false,
      "claude-opus-5-5-high": false,
      "claude-opus-5-5-xhigh": false,
      "claude-opus-5-5-max": false
    },
    "requestModelId": "claude-opus-5-5-low",
    "modelClass": "anthropic",
    "family": "opus"
  },
  {
    "model": {
      "id": "claude-opus-5-5-fast",
      "name": "Claude Opus 5.5 1M Fast",
      "api": "cursor-agent",
      "provider": "cursor",
      "baseUrl": "https://api2.cursor.sh",
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
      "maxTokens": 64000,
      "thinkingLevelMap": {
        "low": "claude-opus-5-5-low-fast",
        "medium": "claude-opus-5-5-medium-fast",
        "high": "claude-opus-5-5-high-fast",
        "xhigh": "claude-opus-5-5-xhigh-fast",
        "max": "claude-opus-5-5-max-fast"
      }
    },
    "maxMode": true,
    "maxModeRoutes": {
      "claude-opus-5-5-low-fast": true,
      "claude-opus-5-5-medium-fast": true,
      "claude-opus-5-5-high-fast": true,
      "claude-opus-5-5-xhigh-fast": true,
      "claude-opus-5-5-max-fast": true
    },
    "requestModelId": "claude-opus-5-5-low-fast",
    "modelClass": "anthropic",
    "family": "opus"
  },
  {
    "model": {
      "id": "claude-opus-5-high",
      "name": "Claude Opus 5 1M",
      "api": "cursor-agent",
      "provider": "cursor",
      "baseUrl": "https://api2.cursor.sh",
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
      "maxTokens": 64000,
      "thinkingLevelMap": {
        "off": "claude-opus-5-high",
        "minimal": "claude-opus-5-thinking-high",
        "low": "claude-opus-5-thinking-high",
        "medium": "claude-opus-5-thinking-high",
        "high": "claude-opus-5-thinking-high"
      }
    },
    "maxMode": false,
    "maxModeRoutes": {
      "claude-opus-5-thinking-high": false
    },
    "requestModelId": "claude-opus-5-high",
    "modelClass": "anthropic",
    "family": "opus"
  },
  {
    "model": {
      "id": "claude-opus-5-high-fast",
      "name": "Claude Opus 5 1M Fast",
      "api": "cursor-agent",
      "provider": "cursor",
      "baseUrl": "https://api2.cursor.sh",
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
      "maxTokens": 64000,
      "thinkingLevelMap": {
        "off": "claude-opus-5-high-fast",
        "minimal": "claude-opus-5-thinking-high-fast",
        "low": "claude-opus-5-thinking-high-fast",
        "medium": "claude-opus-5-thinking-high-fast",
        "high": "claude-opus-5-thinking-high-fast"
      }
    },
    "maxMode": true,
    "maxModeRoutes": {
      "claude-opus-5-thinking-high-fast": true
    },
    "requestModelId": "claude-opus-5-high-fast",
    "modelClass": "anthropic",
    "family": "opus"
  },
  {
    "model": {
      "id": "claude-opus-5-low",
      "name": "Claude Opus 5 1M Low",
      "api": "cursor-agent",
      "provider": "cursor",
      "baseUrl": "https://api2.cursor.sh",
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
      "maxTokens": 64000,
      "thinkingLevelMap": {
        "off": "claude-opus-5-low",
        "minimal": "claude-opus-5-thinking-low",
        "low": "claude-opus-5-thinking-low",
        "medium": "claude-opus-5-thinking-low",
        "high": "claude-opus-5-thinking-low"
      }
    },
    "maxMode": false,
    "maxModeRoutes": {
      "claude-opus-5-thinking-low": false
    },
    "requestModelId": "claude-opus-5-low",
    "modelClass": "anthropic",
    "family": "opus"
  },
  {
    "model": {
      "id": "claude-opus-5-low-fast",
      "name": "Claude Opus 5 1M Low Fast",
      "api": "cursor-agent",
      "provider": "cursor",
      "baseUrl": "https://api2.cursor.sh",
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
      "maxTokens": 64000,
      "thinkingLevelMap": {
        "off": "claude-opus-5-low-fast",
        "minimal": "claude-opus-5-thinking-low-fast",
        "low": "claude-opus-5-thinking-low-fast",
        "medium": "claude-opus-5-thinking-low-fast",
        "high": "claude-opus-5-thinking-low-fast"
      }
    },
    "maxMode": true,
    "maxModeRoutes": {
      "claude-opus-5-thinking-low-fast": true
    },
    "requestModelId": "claude-opus-5-low-fast",
    "modelClass": "anthropic",
    "family": "opus"
  },
  {
    "model": {
      "id": "claude-opus-5-medium",
      "name": "Claude Opus 5 1M Medium",
      "api": "cursor-agent",
      "provider": "cursor",
      "baseUrl": "https://api2.cursor.sh",
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
      "maxTokens": 64000,
      "thinkingLevelMap": {
        "off": "claude-opus-5-medium",
        "minimal": "claude-opus-5-thinking-medium",
        "low": "claude-opus-5-thinking-medium",
        "medium": "claude-opus-5-thinking-medium",
        "high": "claude-opus-5-thinking-medium"
      }
    },
    "maxMode": false,
    "maxModeRoutes": {
      "claude-opus-5-thinking-medium": false
    },
    "requestModelId": "claude-opus-5-medium",
    "modelClass": "anthropic",
    "family": "opus"
  },
  {
    "model": {
      "id": "claude-opus-5-medium-fast",
      "name": "Claude Opus 5 1M Medium Fast",
      "api": "cursor-agent",
      "provider": "cursor",
      "baseUrl": "https://api2.cursor.sh",
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
      "maxTokens": 64000,
      "thinkingLevelMap": {
        "off": "claude-opus-5-medium-fast",
        "minimal": "claude-opus-5-thinking-medium-fast",
        "low": "claude-opus-5-thinking-medium-fast",
        "medium": "claude-opus-5-thinking-medium-fast",
        "high": "claude-opus-5-thinking-medium-fast"
      }
    },
    "maxMode": true,
    "maxModeRoutes": {
      "claude-opus-5-thinking-medium-fast": true
    },
    "requestModelId": "claude-opus-5-medium-fast",
    "modelClass": "anthropic",
    "family": "opus"
  },
  {
    "model": {
      "id": "claude-opus-5-thinking-max",
      "name": "Claude Opus 5 1M Max Thinking",
      "api": "cursor-agent",
      "provider": "cursor",
      "baseUrl": "https://api2.cursor.sh",
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
      "contextWindow": 1000000,
      "maxTokens": 64000
    },
    "maxMode": false,
    "maxModeRoutes": {},
    "requestModelId": "claude-opus-5-thinking-max",
    "modelClass": "anthropic",
    "family": "opus"
  },
  {
    "model": {
      "id": "claude-opus-5-thinking-max-fast",
      "name": "Claude Opus 5 1M Max Thinking Fast",
      "api": "cursor-agent",
      "provider": "cursor",
      "baseUrl": "https://api2.cursor.sh",
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
      "contextWindow": 1000000,
      "maxTokens": 64000
    },
    "maxMode": true,
    "maxModeRoutes": {},
    "requestModelId": "claude-opus-5-thinking-max-fast",
    "modelClass": "anthropic",
    "family": "opus"
  },
  {
    "model": {
      "id": "claude-opus-5-thinking-xhigh",
      "name": "Claude Opus 5 1M Extra High Thinking",
      "api": "cursor-agent",
      "provider": "cursor",
      "baseUrl": "https://api2.cursor.sh",
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
      "contextWindow": 1000000,
      "maxTokens": 64000
    },
    "maxMode": false,
    "maxModeRoutes": {},
    "requestModelId": "claude-opus-5-thinking-xhigh",
    "modelClass": "anthropic",
    "family": "opus"
  },
  {
    "model": {
      "id": "claude-opus-5-thinking-xhigh-fast",
      "name": "Claude Opus 5 1M Extra High Thinking Fast",
      "api": "cursor-agent",
      "provider": "cursor",
      "baseUrl": "https://api2.cursor.sh",
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
      "contextWindow": 1000000,
      "maxTokens": 64000
    },
    "maxMode": true,
    "maxModeRoutes": {},
    "requestModelId": "claude-opus-5-thinking-xhigh-fast",
    "modelClass": "anthropic",
    "family": "opus"
  },
  {
    "model": {
      "id": "claude-sonnet-5-high",
      "name": "Claude Sonnet 5 1M",
      "api": "cursor-agent",
      "provider": "cursor",
      "baseUrl": "https://api2.cursor.sh",
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
      "maxTokens": 64000,
      "thinkingLevelMap": {
        "off": "claude-sonnet-5-high",
        "minimal": "claude-sonnet-5-thinking-high",
        "low": "claude-sonnet-5-thinking-high",
        "medium": "claude-sonnet-5-thinking-high",
        "high": "claude-sonnet-5-thinking-high"
      }
    },
    "maxMode": false,
    "maxModeRoutes": {
      "claude-sonnet-5-thinking-high": false
    },
    "requestModelId": "claude-sonnet-5-high",
    "modelClass": "anthropic",
    "family": "sonnet"
  },
  {
    "model": {
      "id": "claude-sonnet-5-low",
      "name": "Claude Sonnet 5 1M Low",
      "api": "cursor-agent",
      "provider": "cursor",
      "baseUrl": "https://api2.cursor.sh",
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
      "maxTokens": 64000,
      "thinkingLevelMap": {
        "off": "claude-sonnet-5-low",
        "minimal": "claude-sonnet-5-thinking-low",
        "low": "claude-sonnet-5-thinking-low",
        "medium": "claude-sonnet-5-thinking-low",
        "high": "claude-sonnet-5-thinking-low"
      }
    },
    "maxMode": false,
    "maxModeRoutes": {
      "claude-sonnet-5-thinking-low": false
    },
    "requestModelId": "claude-sonnet-5-low",
    "modelClass": "anthropic",
    "family": "sonnet"
  },
  {
    "model": {
      "id": "claude-sonnet-5-max",
      "name": "Claude Sonnet 5 1M Max",
      "api": "cursor-agent",
      "provider": "cursor",
      "baseUrl": "https://api2.cursor.sh",
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
      "maxTokens": 64000,
      "thinkingLevelMap": {
        "off": "claude-sonnet-5-max",
        "minimal": "claude-sonnet-5-thinking-max",
        "low": "claude-sonnet-5-thinking-max",
        "medium": "claude-sonnet-5-thinking-max",
        "high": "claude-sonnet-5-thinking-max"
      }
    },
    "maxMode": false,
    "maxModeRoutes": {
      "claude-sonnet-5-thinking-max": false
    },
    "requestModelId": "claude-sonnet-5-max",
    "modelClass": "anthropic",
    "family": "sonnet"
  },
  {
    "model": {
      "id": "claude-sonnet-5-medium",
      "name": "Claude Sonnet 5 1M Medium",
      "api": "cursor-agent",
      "provider": "cursor",
      "baseUrl": "https://api2.cursor.sh",
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
      "maxTokens": 64000,
      "thinkingLevelMap": {
        "off": "claude-sonnet-5-medium",
        "minimal": "claude-sonnet-5-thinking-medium",
        "low": "claude-sonnet-5-thinking-medium",
        "medium": "claude-sonnet-5-thinking-medium",
        "high": "claude-sonnet-5-thinking-medium"
      }
    },
    "maxMode": false,
    "maxModeRoutes": {
      "claude-sonnet-5-thinking-medium": false
    },
    "requestModelId": "claude-sonnet-5-medium",
    "modelClass": "anthropic",
    "family": "sonnet"
  },
  {
    "model": {
      "id": "claude-sonnet-5-xhigh",
      "name": "Claude Sonnet 5 1M Extra High",
      "api": "cursor-agent",
      "provider": "cursor",
      "baseUrl": "https://api2.cursor.sh",
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
      "maxTokens": 64000,
      "thinkingLevelMap": {
        "off": "claude-sonnet-5-xhigh",
        "minimal": "claude-sonnet-5-thinking-xhigh",
        "low": "claude-sonnet-5-thinking-xhigh",
        "medium": "claude-sonnet-5-thinking-xhigh",
        "high": "claude-sonnet-5-thinking-xhigh"
      }
    },
    "maxMode": false,
    "maxModeRoutes": {
      "claude-sonnet-5-thinking-xhigh": false
    },
    "requestModelId": "claude-sonnet-5-xhigh",
    "modelClass": "anthropic",
    "family": "sonnet"
  },
  {
    "model": {
      "id": "composer-1",
      "name": "Composer 1",
      "api": "cursor-agent",
      "provider": "cursor",
      "baseUrl": "https://api2.cursor.sh",
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
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "maxMode": false,
    "maxModeRoutes": {},
    "requestModelId": "composer-1",
    "modelClass": "unknown",
    "family": ""
  },
  {
    "model": {
      "id": "composer-1.5",
      "name": "Composer 1.5",
      "api": "cursor-agent",
      "provider": "cursor",
      "baseUrl": "https://api2.cursor.sh",
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
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "maxMode": false,
    "maxModeRoutes": {},
    "requestModelId": "composer-1.5",
    "modelClass": "unknown",
    "family": ""
  },
  {
    "model": {
      "id": "composer-2.5",
      "name": "Composer 2.5",
      "api": "cursor-agent",
      "provider": "cursor",
      "baseUrl": "https://api2.cursor.sh",
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
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "maxMode": false,
    "maxModeRoutes": {},
    "requestModelId": "composer-2.5",
    "modelClass": "unknown",
    "family": ""
  },
  {
    "model": {
      "id": "composer-2.5-fast",
      "name": "Composer 2.5 Fast",
      "api": "cursor-agent",
      "provider": "cursor",
      "baseUrl": "https://api2.cursor.sh",
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
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "maxMode": false,
    "maxModeRoutes": {},
    "requestModelId": "composer-2.5-fast",
    "modelClass": "unknown",
    "family": ""
  },
  {
    "model": {
      "id": "cursor-grok-4.5",
      "name": "Grok 4.5",
      "api": "cursor-agent",
      "provider": "cursor",
      "baseUrl": "https://api2.cursor.sh",
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
      "contextWindow": 256000,
      "maxTokens": 64000,
      "thinkingLevelMap": {
        "low": "cursor-grok-4.5-low",
        "medium": "cursor-grok-4.5-medium",
        "high": "cursor-grok-4.5-high"
      }
    },
    "maxMode": false,
    "maxModeRoutes": {
      "cursor-grok-4.5-low": false,
      "cursor-grok-4.5-medium": false,
      "cursor-grok-4.5-high": false
    },
    "requestModelId": "cursor-grok-4.5-medium",
    "modelClass": "xai",
    "family": "grok"
  },
  {
    "model": {
      "id": "cursor-grok-4.5-fast",
      "name": "Grok 4.5 Fast",
      "api": "cursor-agent",
      "provider": "cursor",
      "baseUrl": "https://api2.cursor.sh",
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
      "contextWindow": 256000,
      "maxTokens": 64000,
      "thinkingLevelMap": {
        "low": "cursor-grok-4.5-low-fast",
        "medium": "cursor-grok-4.5-medium-fast",
        "high": "cursor-grok-4.5-high-fast"
      }
    },
    "maxMode": false,
    "maxModeRoutes": {
      "cursor-grok-4.5-low-fast": false,
      "cursor-grok-4.5-medium-fast": false,
      "cursor-grok-4.5-high-fast": false
    },
    "requestModelId": "cursor-grok-4.5-medium-fast",
    "modelClass": "xai",
    "family": "grok"
  },
  {
    "model": {
      "id": "cursor-grok-4.6",
      "name": "Grok 4.6",
      "api": "cursor-agent",
      "provider": "cursor",
      "baseUrl": "https://api2.cursor.sh",
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
      "contextWindow": 256000,
      "maxTokens": 64000,
      "thinkingLevelMap": {
        "low": "cursor-grok-4.6-low",
        "medium": "cursor-grok-4.6-medium",
        "high": "cursor-grok-4.6-high",
        "xhigh": "cursor-grok-4.6-xhigh"
      }
    },
    "maxMode": true,
    "maxModeRoutes": {
      "cursor-grok-4.6-low": false,
      "cursor-grok-4.6-medium": false,
      "cursor-grok-4.6-high": false,
      "cursor-grok-4.6-xhigh": false
    },
    "requestModelId": "cursor-grok-4.6-medium",
    "modelClass": "xai",
    "family": "grok"
  },
  {
    "model": {
      "id": "cursor-grok-4.6-fast",
      "name": "Grok 4.6 Fast",
      "api": "cursor-agent",
      "provider": "cursor",
      "baseUrl": "https://api2.cursor.sh",
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
      "contextWindow": 256000,
      "maxTokens": 64000,
      "thinkingLevelMap": {
        "low": "cursor-grok-4.6-low-fast",
        "medium": "cursor-grok-4.6-medium-fast",
        "high": "cursor-grok-4.6-high-fast",
        "xhigh": "cursor-grok-4.6-xhigh-fast"
      }
    },
    "maxMode": true,
    "maxModeRoutes": {
      "cursor-grok-4.6-low-fast": false,
      "cursor-grok-4.6-medium-fast": false,
      "cursor-grok-4.6-high-fast": false,
      "cursor-grok-4.6-xhigh-fast": false
    },
    "requestModelId": "cursor-grok-4.6-medium-fast",
    "modelClass": "xai",
    "family": "grok"
  },
  {
    "model": {
      "id": "default",
      "name": "Auto",
      "api": "cursor-agent",
      "provider": "cursor",
      "baseUrl": "https://api2.cursor.sh",
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
      "contextWindow": 256000,
      "maxTokens": 64000
    },
    "maxMode": false,
    "maxModeRoutes": {},
    "requestModelId": "default",
    "modelClass": "unknown",
    "family": ""
  },
  {
    "model": {
      "id": "gemini-3-flash",
      "name": "Gemini 3 Flash",
      "api": "cursor-agent",
      "provider": "cursor",
      "baseUrl": "https://api2.cursor.sh",
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
    "maxMode": false,
    "maxModeRoutes": {},
    "requestModelId": "gemini-3-flash",
    "modelClass": "gemini",
    "family": "flash"
  },
  {
    "model": {
      "id": "gemini-3-pro",
      "name": "Gemini 3 Pro",
      "api": "cursor-agent",
      "provider": "cursor",
      "baseUrl": "https://api2.cursor.sh",
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
    "maxMode": false,
    "maxModeRoutes": {},
    "requestModelId": "gemini-3-pro",
    "modelClass": "gemini",
    "family": "pro"
  },
  {
    "model": {
      "id": "gemini-3.1-pro",
      "name": "Gemini 3.1 Pro Preview",
      "api": "cursor-agent",
      "provider": "cursor",
      "baseUrl": "https://api2.cursor.sh",
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
    "maxMode": false,
    "maxModeRoutes": {},
    "requestModelId": "gemini-3.1-pro",
    "modelClass": "gemini",
    "family": "pro"
  },
  {
    "model": {
      "id": "gemini-3.5-flash",
      "name": "Gemini 3.5 Flash",
      "api": "cursor-agent",
      "provider": "cursor",
      "baseUrl": "https://api2.cursor.sh",
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
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "maxMode": false,
    "maxModeRoutes": {},
    "requestModelId": "gemini-3.5-flash",
    "modelClass": "gemini",
    "family": "flash"
  },
  {
    "model": {
      "id": "gemini-3.6-flash",
      "name": "Gemini 3.6 Flash",
      "api": "cursor-agent",
      "provider": "cursor",
      "baseUrl": "https://api2.cursor.sh",
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
      "contextWindow": 200000,
      "maxTokens": 64000,
      "thinkingLevelMap": {
        "minimal": "gemini-3.6-flash-minimal",
        "low": "gemini-3.6-flash-low",
        "medium": "gemini-3.6-flash-medium",
        "high": "gemini-3.6-flash-high"
      }
    },
    "maxMode": false,
    "maxModeRoutes": {
      "gemini-3.6-flash-minimal": false,
      "gemini-3.6-flash-low": false,
      "gemini-3.6-flash-medium": false,
      "gemini-3.6-flash-high": false
    },
    "requestModelId": "gemini-3.6-flash-minimal",
    "modelClass": "gemini",
    "family": "flash"
  },
  {
    "model": {
      "id": "gemini-3.7-flash",
      "name": "Gemini 3.7 Flash",
      "api": "cursor-agent",
      "provider": "cursor",
      "baseUrl": "https://api2.cursor.sh",
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
      "contextWindow": 200000,
      "maxTokens": 64000,
      "thinkingLevelMap": {
        "low": "gemini-3.7-flash-low",
        "medium": "gemini-3.7-flash-medium",
        "high": "gemini-3.7-flash-high"
      }
    },
    "maxMode": false,
    "maxModeRoutes": {
      "gemini-3.7-flash-low": false,
      "gemini-3.7-flash-medium": false,
      "gemini-3.7-flash-high": false
    },
    "requestModelId": "gemini-3.7-flash-low",
    "modelClass": "gemini",
    "family": "flash"
  },
  {
    "model": {
      "id": "gemini-3.8-flash",
      "name": "Gemini 3.8 Flash",
      "api": "cursor-agent",
      "provider": "cursor",
      "baseUrl": "https://api2.cursor.sh",
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
      "contextWindow": 200000,
      "maxTokens": 64000,
      "thinkingLevelMap": {
        "low": "gemini-3.8-flash-low",
        "medium": "gemini-3.8-flash-medium",
        "high": "gemini-3.8-flash-high"
      }
    },
    "maxMode": false,
    "maxModeRoutes": {
      "gemini-3.8-flash-low": false,
      "gemini-3.8-flash-medium": false,
      "gemini-3.8-flash-high": false
    },
    "requestModelId": "gemini-3.8-flash-low",
    "modelClass": "gemini",
    "family": "flash"
  },
  {
    "model": {
      "id": "glm-5.2",
      "name": "GLM-5.2",
      "api": "cursor-agent",
      "provider": "cursor",
      "baseUrl": "https://api2.cursor.sh",
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
      "contextWindow": 1000000,
      "maxTokens": 64000,
      "thinkingLevelMap": {
        "high": "glm-5.2-high",
        "max": "glm-5.2-max"
      }
    },
    "maxMode": false,
    "maxModeRoutes": {
      "glm-5.2-high": false,
      "glm-5.2-max": false
    },
    "requestModelId": "glm-5.2-high",
    "modelClass": "glm",
    "family": ""
  },
  {
    "model": {
      "id": "gpt-5-mini",
      "name": "GPT-5 Mini",
      "api": "cursor-agent",
      "provider": "cursor",
      "baseUrl": "https://api2.cursor.sh",
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
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "maxMode": false,
    "maxModeRoutes": {},
    "requestModelId": "gpt-5-mini",
    "modelClass": "openai",
    "family": "gpt"
  },
  {
    "model": {
      "id": "gpt-5.1",
      "name": "GPT-5.1",
      "api": "cursor-agent",
      "provider": "cursor",
      "baseUrl": "https://api2.cursor.sh",
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
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "maxMode": false,
    "maxModeRoutes": {},
    "requestModelId": "gpt-5.1",
    "modelClass": "openai",
    "family": "gpt"
  },
  {
    "model": {
      "id": "gpt-5.1-codex-max",
      "name": "GPT-5.1 Codex Max",
      "api": "cursor-agent",
      "provider": "cursor",
      "baseUrl": "https://api2.cursor.sh",
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
      "contextWindow": 272000,
      "maxTokens": 128000
    },
    "maxMode": false,
    "maxModeRoutes": {},
    "requestModelId": "gpt-5.1-codex-max",
    "modelClass": "openai",
    "family": "codex"
  },
  {
    "model": {
      "id": "gpt-5.1-codex-max-high",
      "name": "GPT-5.1 Codex Max High",
      "api": "cursor-agent",
      "provider": "cursor",
      "baseUrl": "https://api2.cursor.sh",
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
      "contextWindow": 272000,
      "maxTokens": 128000
    },
    "maxMode": false,
    "maxModeRoutes": {},
    "requestModelId": "gpt-5.1-codex-max-high",
    "modelClass": "openai",
    "family": "codex"
  },
  {
    "model": {
      "id": "gpt-5.1-codex-mini",
      "name": "GPT-5.1 Codex Mini",
      "api": "cursor-agent",
      "provider": "cursor",
      "baseUrl": "https://api2.cursor.sh",
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
      "contextWindow": 272000,
      "maxTokens": 128000
    },
    "maxMode": false,
    "maxModeRoutes": {},
    "requestModelId": "gpt-5.1-codex-mini",
    "modelClass": "openai",
    "family": "codex"
  },
  {
    "model": {
      "id": "gpt-5.1-high",
      "name": "GPT-5.1 High",
      "api": "cursor-agent",
      "provider": "cursor",
      "baseUrl": "https://api2.cursor.sh",
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
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "maxMode": false,
    "maxModeRoutes": {},
    "requestModelId": "gpt-5.1-high",
    "modelClass": "openai",
    "family": "gpt"
  },
  {
    "model": {
      "id": "gpt-5.1-low",
      "name": "GPT-5.1 Low",
      "api": "cursor-agent",
      "provider": "cursor",
      "baseUrl": "https://api2.cursor.sh",
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
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "maxMode": false,
    "maxModeRoutes": {},
    "requestModelId": "gpt-5.1-low",
    "modelClass": "openai",
    "family": "gpt"
  },
  {
    "model": {
      "id": "gpt-5.2",
      "name": "GPT-5.2",
      "api": "cursor-agent",
      "provider": "cursor",
      "baseUrl": "https://api2.cursor.sh",
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
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "maxMode": false,
    "maxModeRoutes": {},
    "requestModelId": "gpt-5.2",
    "modelClass": "openai",
    "family": "gpt"
  },
  {
    "model": {
      "id": "gpt-5.2-codex",
      "name": "GPT-5.2 Codex",
      "api": "cursor-agent",
      "provider": "cursor",
      "baseUrl": "https://api2.cursor.sh",
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
      "contextWindow": 272000,
      "maxTokens": 128000
    },
    "maxMode": false,
    "maxModeRoutes": {},
    "requestModelId": "gpt-5.2-codex",
    "modelClass": "openai",
    "family": "codex"
  },
  {
    "model": {
      "id": "gpt-5.2-codex-fast",
      "name": "GPT-5.2 Codex Fast",
      "api": "cursor-agent",
      "provider": "cursor",
      "baseUrl": "https://api2.cursor.sh",
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
      "contextWindow": 272000,
      "maxTokens": 64000
    },
    "maxMode": false,
    "maxModeRoutes": {},
    "requestModelId": "gpt-5.2-codex-fast",
    "modelClass": "openai",
    "family": "codex"
  },
  {
    "model": {
      "id": "gpt-5.2-codex-high",
      "name": "GPT-5.2 Codex High",
      "api": "cursor-agent",
      "provider": "cursor",
      "baseUrl": "https://api2.cursor.sh",
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
      "contextWindow": 272000,
      "maxTokens": 64000
    },
    "maxMode": false,
    "maxModeRoutes": {},
    "requestModelId": "gpt-5.2-codex-high",
    "modelClass": "openai",
    "family": "codex"
  },
  {
    "model": {
      "id": "gpt-5.2-codex-high-fast",
      "name": "GPT-5.2 Codex High Fast",
      "api": "cursor-agent",
      "provider": "cursor",
      "baseUrl": "https://api2.cursor.sh",
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
      "contextWindow": 272000,
      "maxTokens": 64000
    },
    "maxMode": false,
    "maxModeRoutes": {},
    "requestModelId": "gpt-5.2-codex-high-fast",
    "modelClass": "openai",
    "family": "codex"
  },
  {
    "model": {
      "id": "gpt-5.2-codex-low",
      "name": "GPT-5.2 Codex Low",
      "api": "cursor-agent",
      "provider": "cursor",
      "baseUrl": "https://api2.cursor.sh",
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
      "contextWindow": 272000,
      "maxTokens": 64000
    },
    "maxMode": false,
    "maxModeRoutes": {},
    "requestModelId": "gpt-5.2-codex-low",
    "modelClass": "openai",
    "family": "codex"
  },
  {
    "model": {
      "id": "gpt-5.2-codex-low-fast",
      "name": "GPT-5.2 Codex Low Fast",
      "api": "cursor-agent",
      "provider": "cursor",
      "baseUrl": "https://api2.cursor.sh",
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
      "contextWindow": 272000,
      "maxTokens": 64000
    },
    "maxMode": false,
    "maxModeRoutes": {},
    "requestModelId": "gpt-5.2-codex-low-fast",
    "modelClass": "openai",
    "family": "codex"
  },
  {
    "model": {
      "id": "gpt-5.2-codex-xhigh",
      "name": "GPT-5.2 Codex Extra High",
      "api": "cursor-agent",
      "provider": "cursor",
      "baseUrl": "https://api2.cursor.sh",
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
      "contextWindow": 272000,
      "maxTokens": 64000
    },
    "maxMode": false,
    "maxModeRoutes": {},
    "requestModelId": "gpt-5.2-codex-xhigh",
    "modelClass": "openai",
    "family": "codex"
  },
  {
    "model": {
      "id": "gpt-5.2-codex-xhigh-fast",
      "name": "GPT-5.2 Codex Extra High Fast",
      "api": "cursor-agent",
      "provider": "cursor",
      "baseUrl": "https://api2.cursor.sh",
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
      "contextWindow": 272000,
      "maxTokens": 64000
    },
    "maxMode": false,
    "maxModeRoutes": {},
    "requestModelId": "gpt-5.2-codex-xhigh-fast",
    "modelClass": "openai",
    "family": "codex"
  },
  {
    "model": {
      "id": "gpt-5.2-fast",
      "name": "GPT-5.2 Fast",
      "api": "cursor-agent",
      "provider": "cursor",
      "baseUrl": "https://api2.cursor.sh",
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
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "maxMode": false,
    "maxModeRoutes": {},
    "requestModelId": "gpt-5.2-fast",
    "modelClass": "openai",
    "family": "gpt"
  },
  {
    "model": {
      "id": "gpt-5.2-high",
      "name": "GPT-5.2 High",
      "api": "cursor-agent",
      "provider": "cursor",
      "baseUrl": "https://api2.cursor.sh",
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
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "maxMode": false,
    "maxModeRoutes": {},
    "requestModelId": "gpt-5.2-high",
    "modelClass": "openai",
    "family": "gpt"
  },
  {
    "model": {
      "id": "gpt-5.2-high-fast",
      "name": "GPT-5.2 High Fast",
      "api": "cursor-agent",
      "provider": "cursor",
      "baseUrl": "https://api2.cursor.sh",
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
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "maxMode": false,
    "maxModeRoutes": {},
    "requestModelId": "gpt-5.2-high-fast",
    "modelClass": "openai",
    "family": "gpt"
  },
  {
    "model": {
      "id": "gpt-5.2-low",
      "name": "GPT-5.2 Low",
      "api": "cursor-agent",
      "provider": "cursor",
      "baseUrl": "https://api2.cursor.sh",
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
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "maxMode": false,
    "maxModeRoutes": {},
    "requestModelId": "gpt-5.2-low",
    "modelClass": "openai",
    "family": "gpt"
  },
  {
    "model": {
      "id": "gpt-5.2-low-fast",
      "name": "GPT-5.2 Low Fast",
      "api": "cursor-agent",
      "provider": "cursor",
      "baseUrl": "https://api2.cursor.sh",
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
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "maxMode": false,
    "maxModeRoutes": {},
    "requestModelId": "gpt-5.2-low-fast",
    "modelClass": "openai",
    "family": "gpt"
  },
  {
    "model": {
      "id": "gpt-5.2-xhigh",
      "name": "GPT-5.2 Extra High",
      "api": "cursor-agent",
      "provider": "cursor",
      "baseUrl": "https://api2.cursor.sh",
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
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "maxMode": false,
    "maxModeRoutes": {},
    "requestModelId": "gpt-5.2-xhigh",
    "modelClass": "openai",
    "family": "gpt"
  },
  {
    "model": {
      "id": "gpt-5.2-xhigh-fast",
      "name": "GPT-5.2 Extra High Fast",
      "api": "cursor-agent",
      "provider": "cursor",
      "baseUrl": "https://api2.cursor.sh",
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
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "maxMode": false,
    "maxModeRoutes": {},
    "requestModelId": "gpt-5.2-xhigh-fast",
    "modelClass": "openai",
    "family": "gpt"
  },
  {
    "model": {
      "id": "gpt-5.3-codex",
      "name": "GPT-5.3 Codex",
      "api": "cursor-agent",
      "provider": "cursor",
      "baseUrl": "https://api2.cursor.sh",
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
      "contextWindow": 272000,
      "maxTokens": 128000
    },
    "maxMode": false,
    "maxModeRoutes": {},
    "requestModelId": "gpt-5.3-codex",
    "modelClass": "openai",
    "family": "codex"
  },
  {
    "model": {
      "id": "gpt-5.3-codex-fast",
      "name": "Codex 5.3 Fast",
      "api": "cursor-agent",
      "provider": "cursor",
      "baseUrl": "https://api2.cursor.sh",
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
      "contextWindow": 272000,
      "maxTokens": 64000
    },
    "maxMode": false,
    "maxModeRoutes": {},
    "requestModelId": "gpt-5.3-codex-fast",
    "modelClass": "openai",
    "family": "codex"
  },
  {
    "model": {
      "id": "gpt-5.3-codex-high",
      "name": "Codex 5.3 High",
      "api": "cursor-agent",
      "provider": "cursor",
      "baseUrl": "https://api2.cursor.sh",
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
      "contextWindow": 272000,
      "maxTokens": 64000
    },
    "maxMode": false,
    "maxModeRoutes": {},
    "requestModelId": "gpt-5.3-codex-high",
    "modelClass": "openai",
    "family": "codex"
  },
  {
    "model": {
      "id": "gpt-5.3-codex-high-fast",
      "name": "Codex 5.3 High Fast",
      "api": "cursor-agent",
      "provider": "cursor",
      "baseUrl": "https://api2.cursor.sh",
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
      "contextWindow": 272000,
      "maxTokens": 64000
    },
    "maxMode": false,
    "maxModeRoutes": {},
    "requestModelId": "gpt-5.3-codex-high-fast",
    "modelClass": "openai",
    "family": "codex"
  },
  {
    "model": {
      "id": "gpt-5.3-codex-low",
      "name": "Codex 5.3 Low",
      "api": "cursor-agent",
      "provider": "cursor",
      "baseUrl": "https://api2.cursor.sh",
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
      "contextWindow": 272000,
      "maxTokens": 64000
    },
    "maxMode": false,
    "maxModeRoutes": {},
    "requestModelId": "gpt-5.3-codex-low",
    "modelClass": "openai",
    "family": "codex"
  },
  {
    "model": {
      "id": "gpt-5.3-codex-low-fast",
      "name": "Codex 5.3 Low Fast",
      "api": "cursor-agent",
      "provider": "cursor",
      "baseUrl": "https://api2.cursor.sh",
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
      "contextWindow": 272000,
      "maxTokens": 64000
    },
    "maxMode": false,
    "maxModeRoutes": {},
    "requestModelId": "gpt-5.3-codex-low-fast",
    "modelClass": "openai",
    "family": "codex"
  },
  {
    "model": {
      "id": "gpt-5.3-codex-spark-preview",
      "name": "GPT-5.3 Codex Spark",
      "api": "cursor-agent",
      "provider": "cursor",
      "baseUrl": "https://api2.cursor.sh",
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
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "maxMode": false,
    "maxModeRoutes": {},
    "requestModelId": "gpt-5.3-codex-spark-preview",
    "modelClass": "openai",
    "family": "codex-spark"
  },
  {
    "model": {
      "id": "gpt-5.3-codex-xhigh",
      "name": "Codex 5.3 Extra High",
      "api": "cursor-agent",
      "provider": "cursor",
      "baseUrl": "https://api2.cursor.sh",
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
      "contextWindow": 272000,
      "maxTokens": 64000
    },
    "maxMode": false,
    "maxModeRoutes": {},
    "requestModelId": "gpt-5.3-codex-xhigh",
    "modelClass": "openai",
    "family": "codex"
  },
  {
    "model": {
      "id": "gpt-5.3-codex-xhigh-fast",
      "name": "Codex 5.3 Extra High Fast",
      "api": "cursor-agent",
      "provider": "cursor",
      "baseUrl": "https://api2.cursor.sh",
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
      "contextWindow": 272000,
      "maxTokens": 64000
    },
    "maxMode": false,
    "maxModeRoutes": {},
    "requestModelId": "gpt-5.3-codex-xhigh-fast",
    "modelClass": "openai",
    "family": "codex"
  },
  {
    "model": {
      "id": "gpt-5.4",
      "name": "GPT-5.4",
      "api": "cursor-agent",
      "provider": "cursor",
      "baseUrl": "https://api2.cursor.sh",
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
      "maxTokens": 64000,
      "thinkingLevelMap": {
        "low": "gpt-5.4-low",
        "medium": "gpt-5.4-medium",
        "high": "gpt-5.4-high",
        "xhigh": "gpt-5.4-xhigh"
      }
    },
    "maxMode": false,
    "maxModeRoutes": {
      "gpt-5.4-low": false,
      "gpt-5.4-medium": false,
      "gpt-5.4-high": false,
      "gpt-5.4-xhigh": false
    },
    "requestModelId": "gpt-5.4-low",
    "modelClass": "openai",
    "family": "gpt"
  },
  {
    "model": {
      "id": "gpt-5.4-fast",
      "name": "GPT-5.4 Fast",
      "api": "cursor-agent",
      "provider": "cursor",
      "baseUrl": "https://api2.cursor.sh",
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
      "contextWindow": 200000,
      "maxTokens": 64000,
      "thinkingLevelMap": {
        "medium": "gpt-5.4-medium-fast",
        "high": "gpt-5.4-high-fast",
        "xhigh": "gpt-5.4-xhigh-fast"
      }
    },
    "maxMode": false,
    "maxModeRoutes": {
      "gpt-5.4-medium-fast": false,
      "gpt-5.4-high-fast": false,
      "gpt-5.4-xhigh-fast": false
    },
    "requestModelId": "gpt-5.4-medium-fast",
    "modelClass": "openai",
    "family": "gpt"
  },
  {
    "model": {
      "id": "gpt-5.4-mini",
      "name": "GPT-5.4 mini",
      "api": "cursor-agent",
      "provider": "cursor",
      "baseUrl": "https://api2.cursor.sh",
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
      "contextWindow": 200000,
      "maxTokens": 64000,
      "thinkingLevelMap": {
        "off": "gpt-5.4-mini-none",
        "low": "gpt-5.4-mini-low",
        "medium": "gpt-5.4-mini-medium",
        "high": "gpt-5.4-mini-high",
        "xhigh": "gpt-5.4-mini-xhigh"
      }
    },
    "maxMode": false,
    "maxModeRoutes": {
      "gpt-5.4-mini-none": false,
      "gpt-5.4-mini-low": false,
      "gpt-5.4-mini-medium": false,
      "gpt-5.4-mini-high": false,
      "gpt-5.4-mini-xhigh": false
    },
    "requestModelId": "gpt-5.4-mini-none",
    "modelClass": "openai",
    "family": "gpt"
  },
  {
    "model": {
      "id": "gpt-5.4-nano",
      "name": "GPT-5.4 nano",
      "api": "cursor-agent",
      "provider": "cursor",
      "baseUrl": "https://api2.cursor.sh",
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
      "contextWindow": 200000,
      "maxTokens": 64000,
      "thinkingLevelMap": {
        "off": "gpt-5.4-nano-none",
        "low": "gpt-5.4-nano-low",
        "medium": "gpt-5.4-nano-medium",
        "high": "gpt-5.4-nano-high",
        "xhigh": "gpt-5.4-nano-xhigh"
      }
    },
    "maxMode": false,
    "maxModeRoutes": {
      "gpt-5.4-nano-none": false,
      "gpt-5.4-nano-low": false,
      "gpt-5.4-nano-medium": false,
      "gpt-5.4-nano-high": false,
      "gpt-5.4-nano-xhigh": false
    },
    "requestModelId": "gpt-5.4-nano-none",
    "modelClass": "openai",
    "family": "gpt"
  },
  {
    "model": {
      "id": "gpt-5.5",
      "name": "GPT-5.5",
      "api": "cursor-agent",
      "provider": "cursor",
      "baseUrl": "https://api2.cursor.sh",
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
      "maxTokens": 64000,
      "thinkingLevelMap": {
        "off": "gpt-5.5-none",
        "low": "gpt-5.5-low",
        "medium": "gpt-5.5-medium",
        "high": "gpt-5.5-high",
        "xhigh": "gpt-5.5-extra-high"
      }
    },
    "maxMode": false,
    "maxModeRoutes": {
      "gpt-5.5-none": false,
      "gpt-5.5-low": false,
      "gpt-5.5-medium": false,
      "gpt-5.5-high": false,
      "gpt-5.5-extra-high": false
    },
    "requestModelId": "gpt-5.5-none",
    "modelClass": "openai",
    "family": "gpt"
  },
  {
    "model": {
      "id": "gpt-5.5-fast",
      "name": "GPT-5.5 Extra Fast",
      "api": "cursor-agent",
      "provider": "cursor",
      "baseUrl": "https://api2.cursor.sh",
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
      "contextWindow": 200000,
      "maxTokens": 64000,
      "thinkingLevelMap": {
        "off": "gpt-5.5-none-fast",
        "low": "gpt-5.5-low-fast",
        "medium": "gpt-5.5-medium-fast",
        "high": "gpt-5.5-high-fast",
        "xhigh": "gpt-5.5-extra-high-fast"
      }
    },
    "maxMode": false,
    "maxModeRoutes": {
      "gpt-5.5-none-fast": false,
      "gpt-5.5-low-fast": false,
      "gpt-5.5-medium-fast": false,
      "gpt-5.5-high-fast": false,
      "gpt-5.5-extra-high-fast": false
    },
    "requestModelId": "gpt-5.5-none-fast",
    "modelClass": "openai",
    "family": "gpt"
  },
  {
    "model": {
      "id": "gpt-5.6-luna",
      "name": "GPT-5.6 Luna",
      "api": "cursor-agent",
      "provider": "cursor",
      "baseUrl": "https://api2.cursor.sh",
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
      "maxTokens": 64000,
      "thinkingLevelMap": {
        "off": "gpt-5.6-luna-none",
        "low": "gpt-5.6-luna-low",
        "medium": "gpt-5.6-luna-medium",
        "high": "gpt-5.6-luna-high",
        "xhigh": "gpt-5.6-luna-xhigh",
        "max": "gpt-5.6-luna-max"
      }
    },
    "maxMode": true,
    "maxModeRoutes": {
      "gpt-5.6-luna-none": false,
      "gpt-5.6-luna-low": false,
      "gpt-5.6-luna-medium": false,
      "gpt-5.6-luna-high": false,
      "gpt-5.6-luna-xhigh": false,
      "gpt-5.6-luna-max": false
    },
    "requestModelId": "gpt-5.6-luna-none",
    "modelClass": "openai",
    "family": "gpt"
  },
  {
    "model": {
      "id": "gpt-5.6-luna-fast",
      "name": "GPT-5.6 Luna Fast",
      "api": "cursor-agent",
      "provider": "cursor",
      "baseUrl": "https://api2.cursor.sh",
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
      "contextWindow": 272000,
      "maxTokens": 64000,
      "thinkingLevelMap": {
        "off": "gpt-5.6-luna-none-fast",
        "low": "gpt-5.6-luna-low-fast",
        "medium": "gpt-5.6-luna-medium-fast",
        "high": "gpt-5.6-luna-high-fast",
        "xhigh": "gpt-5.6-luna-xhigh-fast",
        "max": "gpt-5.6-luna-max-fast"
      }
    },
    "maxMode": true,
    "maxModeRoutes": {
      "gpt-5.6-luna-none-fast": false,
      "gpt-5.6-luna-low-fast": false,
      "gpt-5.6-luna-medium-fast": false,
      "gpt-5.6-luna-high-fast": false,
      "gpt-5.6-luna-xhigh-fast": false,
      "gpt-5.6-luna-max-fast": false
    },
    "requestModelId": "gpt-5.6-luna-none-fast",
    "modelClass": "openai",
    "family": "gpt"
  },
  {
    "model": {
      "id": "gpt-5.6-sol",
      "name": "GPT-5.6 Sol",
      "api": "cursor-agent",
      "provider": "cursor",
      "baseUrl": "https://api2.cursor.sh",
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
      "maxTokens": 64000,
      "thinkingLevelMap": {
        "off": "gpt-5.6-sol-none",
        "low": "gpt-5.6-sol-low",
        "medium": "gpt-5.6-sol-medium",
        "high": "gpt-5.6-sol-high",
        "xhigh": "gpt-5.6-sol-xhigh",
        "max": "gpt-5.6-sol-max"
      }
    },
    "maxMode": true,
    "maxModeRoutes": {
      "gpt-5.6-sol-none": false,
      "gpt-5.6-sol-low": false,
      "gpt-5.6-sol-medium": false,
      "gpt-5.6-sol-high": false,
      "gpt-5.6-sol-xhigh": false,
      "gpt-5.6-sol-max": false
    },
    "requestModelId": "gpt-5.6-sol-none",
    "modelClass": "openai",
    "family": "gpt"
  },
  {
    "model": {
      "id": "gpt-5.6-sol-fast",
      "name": "GPT-5.6 Sol Fast",
      "api": "cursor-agent",
      "provider": "cursor",
      "baseUrl": "https://api2.cursor.sh",
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
      "contextWindow": 272000,
      "maxTokens": 64000,
      "thinkingLevelMap": {
        "off": "gpt-5.6-sol-none-fast",
        "low": "gpt-5.6-sol-low-fast",
        "medium": "gpt-5.6-sol-medium-fast",
        "high": "gpt-5.6-sol-high-fast",
        "xhigh": "gpt-5.6-sol-xhigh-fast",
        "max": "gpt-5.6-sol-max-fast"
      }
    },
    "maxMode": true,
    "maxModeRoutes": {
      "gpt-5.6-sol-none-fast": false,
      "gpt-5.6-sol-low-fast": false,
      "gpt-5.6-sol-medium-fast": false,
      "gpt-5.6-sol-high-fast": false,
      "gpt-5.6-sol-xhigh-fast": false,
      "gpt-5.6-sol-max-fast": false
    },
    "requestModelId": "gpt-5.6-sol-none-fast",
    "modelClass": "openai",
    "family": "gpt"
  },
  {
    "model": {
      "id": "gpt-5.6-terra",
      "name": "GPT-5.6 Terra",
      "api": "cursor-agent",
      "provider": "cursor",
      "baseUrl": "https://api2.cursor.sh",
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
      "maxTokens": 64000,
      "thinkingLevelMap": {
        "off": "gpt-5.6-terra-none",
        "low": "gpt-5.6-terra-low",
        "medium": "gpt-5.6-terra-medium",
        "high": "gpt-5.6-terra-high",
        "xhigh": "gpt-5.6-terra-xhigh",
        "max": "gpt-5.6-terra-max"
      }
    },
    "maxMode": true,
    "maxModeRoutes": {
      "gpt-5.6-terra-none": false,
      "gpt-5.6-terra-low": false,
      "gpt-5.6-terra-medium": false,
      "gpt-5.6-terra-high": false,
      "gpt-5.6-terra-xhigh": false,
      "gpt-5.6-terra-max": false
    },
    "requestModelId": "gpt-5.6-terra-none",
    "modelClass": "openai",
    "family": "gpt"
  },
  {
    "model": {
      "id": "gpt-5.6-terra-fast",
      "name": "GPT-5.6 Terra Fast",
      "api": "cursor-agent",
      "provider": "cursor",
      "baseUrl": "https://api2.cursor.sh",
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
      "contextWindow": 272000,
      "maxTokens": 64000,
      "thinkingLevelMap": {
        "off": "gpt-5.6-terra-none-fast",
        "low": "gpt-5.6-terra-low-fast",
        "medium": "gpt-5.6-terra-medium-fast",
        "high": "gpt-5.6-terra-high-fast",
        "xhigh": "gpt-5.6-terra-xhigh-fast",
        "max": "gpt-5.6-terra-max-fast"
      }
    },
    "maxMode": true,
    "maxModeRoutes": {
      "gpt-5.6-terra-none-fast": false,
      "gpt-5.6-terra-low-fast": false,
      "gpt-5.6-terra-medium-fast": false,
      "gpt-5.6-terra-high-fast": false,
      "gpt-5.6-terra-xhigh-fast": false,
      "gpt-5.6-terra-max-fast": false
    },
    "requestModelId": "gpt-5.6-terra-none-fast",
    "modelClass": "openai",
    "family": "gpt"
  },
  {
    "model": {
      "id": "grok-4.7-high",
      "name": "Grok 4.7 High",
      "api": "cursor-agent",
      "provider": "cursor",
      "baseUrl": "https://api2.cursor.sh",
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
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "maxMode": false,
    "maxModeRoutes": {},
    "requestModelId": "grok-4.7-high",
    "modelClass": "xai",
    "family": "grok"
  },
  {
    "model": {
      "id": "grok-4.7-high-fast",
      "name": "Grok 4.7 High Fast​​",
      "api": "cursor-agent",
      "provider": "cursor",
      "baseUrl": "https://api2.cursor.sh",
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
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "maxMode": false,
    "maxModeRoutes": {},
    "requestModelId": "grok-4.7-high-fast",
    "modelClass": "xai",
    "family": "grok"
  },
  {
    "model": {
      "id": "grok-4.7-low",
      "name": "Grok 4.7 Low",
      "api": "cursor-agent",
      "provider": "cursor",
      "baseUrl": "https://api2.cursor.sh",
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
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "maxMode": false,
    "maxModeRoutes": {},
    "requestModelId": "grok-4.7-low",
    "modelClass": "xai",
    "family": "grok"
  },
  {
    "model": {
      "id": "grok-4.7-low-fast",
      "name": "Grok 4.7 Low Fast​​",
      "api": "cursor-agent",
      "provider": "cursor",
      "baseUrl": "https://api2.cursor.sh",
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
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "maxMode": false,
    "maxModeRoutes": {},
    "requestModelId": "grok-4.7-low-fast",
    "modelClass": "xai",
    "family": "grok"
  },
  {
    "model": {
      "id": "grok-4.7-medium",
      "name": "Grok 4.7 Medium",
      "api": "cursor-agent",
      "provider": "cursor",
      "baseUrl": "https://api2.cursor.sh",
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
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "maxMode": false,
    "maxModeRoutes": {},
    "requestModelId": "grok-4.7-medium",
    "modelClass": "xai",
    "family": "grok"
  },
  {
    "model": {
      "id": "grok-4.7-medium-fast",
      "name": "Grok 4.7 Medium Fast​​",
      "api": "cursor-agent",
      "provider": "cursor",
      "baseUrl": "https://api2.cursor.sh",
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
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "maxMode": false,
    "maxModeRoutes": {},
    "requestModelId": "grok-4.7-medium-fast",
    "modelClass": "xai",
    "family": "grok"
  },
  {
    "model": {
      "id": "grok-4.7-xhigh",
      "name": "Grok 4.7 Extra High",
      "api": "cursor-agent",
      "provider": "cursor",
      "baseUrl": "https://api2.cursor.sh",
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
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "maxMode": false,
    "maxModeRoutes": {},
    "requestModelId": "grok-4.7-xhigh",
    "modelClass": "xai",
    "family": "grok"
  },
  {
    "model": {
      "id": "grok-4.7-xhigh-fast",
      "name": "Grok 4.7 Extra High Fast​​",
      "api": "cursor-agent",
      "provider": "cursor",
      "baseUrl": "https://api2.cursor.sh",
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
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "maxMode": false,
    "maxModeRoutes": {},
    "requestModelId": "grok-4.7-xhigh-fast",
    "modelClass": "xai",
    "family": "grok"
  },
  {
    "model": {
      "id": "grok-code-fast-1",
      "name": "Grok Code Fast 1",
      "api": "cursor-agent",
      "provider": "cursor",
      "baseUrl": "https://api2.cursor.sh",
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
      "contextWindow": 256000,
      "maxTokens": 10000
    },
    "maxMode": false,
    "maxModeRoutes": {},
    "requestModelId": "grok-code-fast-1",
    "modelClass": "xai",
    "family": "grok"
  },
  {
    "model": {
      "id": "kimi-k2.5",
      "name": "kimi-k2.5",
      "api": "cursor-agent",
      "provider": "cursor",
      "baseUrl": "https://api2.cursor.sh",
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
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "maxMode": false,
    "maxModeRoutes": {},
    "requestModelId": "kimi-k2.5",
    "modelClass": "kimi",
    "family": "k2.5"
  },
  {
    "model": {
      "id": "kimi-k2.7-code",
      "name": "Kimi K2.7 Code",
      "api": "cursor-agent",
      "provider": "cursor",
      "baseUrl": "https://api2.cursor.sh",
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
      "contextWindow": 262000,
      "maxTokens": 64000
    },
    "maxMode": false,
    "maxModeRoutes": {},
    "requestModelId": "kimi-k2.7-code",
    "modelClass": "kimi",
    "family": "k2.7-code"
  },
  {
    "model": {
      "id": "kimi-k3-high",
      "name": "Kimi K3 High",
      "api": "cursor-agent",
      "provider": "cursor",
      "baseUrl": "https://api2.cursor.sh",
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
    "maxMode": false,
    "maxModeRoutes": {},
    "requestModelId": "kimi-k3-high",
    "modelClass": "kimi",
    "family": "k3"
  },
  {
    "model": {
      "id": "kimi-k3-low",
      "name": "Kimi K3 Low",
      "api": "cursor-agent",
      "provider": "cursor",
      "baseUrl": "https://api2.cursor.sh",
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
    "maxMode": false,
    "maxModeRoutes": {},
    "requestModelId": "kimi-k3-low",
    "modelClass": "kimi",
    "family": "k3"
  },
  {
    "model": {
      "id": "kimi-k3-max",
      "name": "Kimi K3",
      "api": "cursor-agent",
      "provider": "cursor",
      "baseUrl": "https://api2.cursor.sh",
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
    "maxMode": false,
    "maxModeRoutes": {},
    "requestModelId": "kimi-k3-max",
    "modelClass": "kimi",
    "family": "k3"
  },
  {
    "model": {
      "id": "muse-spark-1.3",
      "name": "Muse Spark 1.3",
      "api": "cursor-agent",
      "provider": "cursor",
      "baseUrl": "https://api2.cursor.sh",
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
      "maxTokens": 64000,
      "thinkingLevelMap": {
        "minimal": "muse-spark-1.3-minimal",
        "low": "muse-spark-1.3-low",
        "medium": "muse-spark-1.3-medium",
        "high": "muse-spark-1.3-high",
        "xhigh": "muse-spark-1.3-xhigh",
        "max": "muse-spark-1.3-max"
      }
    },
    "maxMode": false,
    "maxModeRoutes": {
      "muse-spark-1.3-minimal": false,
      "muse-spark-1.3-low": false,
      "muse-spark-1.3-medium": false,
      "muse-spark-1.3-high": false,
      "muse-spark-1.3-xhigh": false,
      "muse-spark-1.3-max": false
    },
    "requestModelId": "muse-spark-1.3-minimal",
    "modelClass": "meta",
    "family": "muse-spark"
  }
];
