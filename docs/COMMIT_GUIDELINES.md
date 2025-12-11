# Commit Guidelines & Workflow

## Branching Strategy

We use a 3-branch strategy for our development lifecycle:

1.  **`work`**: The main development branch. All daily coding and feature implementation happens here.
2.  **`staging`**: The staging branch. Merges from `work` go here to be tested in a production-like environment before going live.
3.  **`master`**: The production branch. Only thoroughly tested stable code from `staging` is merged here.
## Pre-commit Checks

Before committing your code, especially on the `work` branch, ensure you run the following commands to maintain code quality:

1.  **Type Check**: Ensure there are no TypeScript errors.

    ```bash
    npm run typecheck
    ```

2.  **Linting**: Catch potential bugs and enforce coding standards.

    ```bash
    npm run lint
    ```

3.  **Testing**: Run the test suite to ensure no regressions.

    ```bash
    npm run test
    ```

4.  **Formatting**: Ensure code style consistency (optional if you have auto-format on save).
    ```bash
    npm run format
    ```

**Pro Tip**: You can chain these commands:

```bash
npm run typecheck && npm run lint && npm run test
```

## Commit Message Format

We follow the **Conventional Commits** specification. This creates a readable history and allows for automated release notes.

**Structure:**

```text
<type>(<scope>): <short description>
```

### 1. Types

- **`feat`**: A new feature (e.g., adding a new API endpoint).
- **`fix`**: A bug fix.
- **`docs`**: Documentation only changes.
- **`style`**: Changes that do not affect the meaning of the code (white-space, formatting, etc).
- **`refactor`**: A code change that neither fixes a bug nor adds a feature.
- **`test`**: Adding missing tests or correcting existing tests.
- **`chore`**: Changes to the build process or auxiliary tools and libraries (e.g., updating dependencies).

### 2. Scope (Optional)

The scope provides additional context, usually the module or file being changed.

- Example: `(auth)`, `(api)`, `(db)`, `(websocket)`

### 3. Description

A concise summary of the change in imperative mood (e.g., "add", not "added").

### Examples

**Good:**

- `feat(auth): implement JWT token validation`
- `fix(server): resolve connection timeout issue`
- `chore: update socket.io dependency to v4.8`
- `docs: update README with deployment steps`

**Bad:**

- `fixed bug` (Too vague)
- `update` (No context)
- `feat: Added validation` (Use "add" instead of "Added")
