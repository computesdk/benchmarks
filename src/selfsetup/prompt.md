# AI Self-Setup Benchmark Prompt

You are participating in a benchmark test for {{PROVIDER_NAME}}.

## Your Environment
- Working directory: {{WORK_DIR}}
- Node.js project initialized (package.json exists)
- TypeScript and tsx are available

## Your Task
Set up {{PROVIDER_NAME}} end-to-end and prove it works by running 'node -v' in a sandbox.

## Credentials Available (in environment)
{{CREDENTIALS_LIST}}

## Steps You Must Complete

### Step 1: Discovery (Find docs & SDK)
- Search for the official {{PROVIDER_NAME}} SDK
- Find the main documentation page
- Identify the correct npm package to install
- Note the SDK version, main entry point, and basic usage

### Step 2: Installation
- Install the SDK: `npm install <package>`
- Handle any peer dependencies or TypeScript types needed
- Verify the import works

### Step 3: Configuration
- Read the credentials from environment variables
- Initialize the SDK with proper authentication
- Handle any required setup steps

### Step 4: Integration
- Write minimal code to:
  1. Create/connect to a sandbox
  2. Run the command 'node -v'
  3. Get the output
  4. Clean up/destroy the sandbox
- Save this code to {{WORK_DIR}}/test-{{PROVIDER_NAME}}.ts

### Step 5: Execution
- Run your test code: `npx tsx test-{{PROVIDER_NAME}}.ts`
- Capture the output
- Verify 'node -v' succeeded

## Constraints & Rules

1. **15 minute time limit** - Work efficiently
2. **No human help** - Do not ask for clarification or assistance
3. **Public docs only** - Use web search, npm registry, official docs
4. **Minimal code** - Keep it simple and clean
5. **Error recovery** - If something fails, try an alternative approach
6. **Document issues** - Note any problems with docs, SDK, or setup

## Success Criteria

You have succeeded when:
- [ ] SDK is installed without errors
- [ ] Code creates a working sandbox
- [ ] `node -v` runs and returns a version string
- [ ] Sandbox is properly cleaned up
- [ ] You have a record of time taken

## Output

When done (success or failure), write a JSON summary to {{WORK_DIR}}/result.json:

```json
{
  "provider": "{{PROVIDER_NAME}}",
  "success": true,
  "timestamp": "2026-03-31T12:00:00Z",
  "totalTimeMs": 187000,
  "steps": [
    {
      "name": "discovery",
      "completed": true,
      "timeMs": 45000,
      "metadata": {
        "urlFound": "https://docs.example.com",
        "packageName": "@example/sdk"
      }
    },
    {
      "name": "installation",
      "completed": true,
      "timeMs": 23000,
      "metadata": {
        "packageName": "@example/sdk",
        "version": "1.2.3"
      }
    },
    {
      "name": "configuration",
      "completed": true,
      "timeMs": 12000,
      "metadata": {
        "method": "env-var",
        "issues": []
      }
    },
    {
      "name": "integration",
      "completed": true,
      "timeMs": 67000,
      "metadata": {
        "filesCreated": ["test-example.ts"],
        "linesOfCode": 12
      }
    },
    {
      "name": "execution",
      "completed": true,
      "timeMs": 40000,
      "metadata": {
        "output": "v20.11.0",
        "exitCode": 0
      }
    },
    {
      "name": "verification",
      "completed": true,
      "timeMs": 5000
    },
    {
      "name": "cleanup",
      "completed": true,
      "timeMs": 3000
    }
  ],
  "errors": [
    {
      "message": "...",
      "step": "installation",
      "handled": true,
      "timestamp": "2026-03-31T12:01:23Z"
    }
  ],
  "humanInterventions": 0,
  "docComplaints": 0,
  "codeQuality": "excellent",
  "filesCreated": ["test-{{PROVIDER_NAME}}.ts", ".env"],
  "executionOutput": "v20.11.0"
}
```

## Code Quality Grading

Self-assess your code as one of:
- **excellent**: Clean, idiomatic, handles errors, proper cleanup
- **good**: Works well, minor style issues
- **messy**: Functional but hacky
- **failed**: Doesn't work or incomplete

## Doc Complaints

Increment docComplaints when:
- You can't find the install command
- Authentication is unclear
- No hello-world example exists
- Types/TypeScript support is broken
- You have to guess at API usage

## Time Tracking

Track your time for each step. Start timing from when you begin Step 1.

---

**BEGIN NOW.** You have 15 minutes. Good luck!
