export interface SandboxResult {
  stdout: string;
  stderr: string;
  returnCode: number;
  files: Array<{ name: string; base64: string; mimeType: string }>;
  executionTimeMs: number;
}

export class SandboxService {
  private readonly url: string;

  constructor() {
    this.url = process.env['SANDBOX_URL'] ?? 'http://sandbox:8000';
  }

  async executeCode(code: string, timeoutSeconds = 30): Promise<SandboxResult> {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      (timeoutSeconds + 5) * 1000,
    );

    try {
      const response = await fetch(`${this.url}/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, timeout: timeoutSeconds }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(
          `Sandbox returned ${response.status}: ${await response.text()}`,
        );
      }

      return (await response.json()) as SandboxResult;
    } finally {
      clearTimeout(timer);
    }
  }

  async isHealthy(): Promise<boolean> {
    try {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 5000);
      const response = await fetch(`${this.url}/health`, {
        signal: controller.signal,
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}

export const sandboxService = new SandboxService();
