# Workspace Customization & Developer Guidelines

Welcome to the Konfident Interview 2025 project. This file provides guidelines for human developers and agent assistants collaborating on this repository.

---

## 1. Multiple Developer Instructions

### Git Branching and Pull Request Workflow
To keep the codebase clean and stable, follow this workflow:
- **Main Branch Protection**: Never push directly to `main`. All changes must go through a pull request (PR).
- **Branch Naming Conventions**:
  - Features: `feature/short-description` (e.g. `feature/slot-validation`)
  - Fixes: `bugfix/short-description` (e.g. `bugfix/overlap-check`)
  - Docs: `docs/short-description` (e.g. `docs/update-readme`)
- **PR Process**:
  1. Pull the latest code from `main`.
  2. Create your branch.
  3. Implement your changes.
  4. Run and verify tests using `npm test`.
  5. Open a PR, ensure all checks pass, and request a review from another developer.

### Git Commit Conventions
Use Conventional Commits to maintain a clean history. Format messages as `<type>(<scope>): <description>`:
- `feat`: A new feature (e.g., `feat(admin): add slot overlap checks`)
- `fix`: A bug fix (e.g., `fix(student): trim initials parsing`)
- `docs`: Documentation updates (e.g., `docs(git): add PR templates`)
- `style`: Changes that do not affect code logic (formatting, whitespace, CSS tweaks)
- `refactor`: Code reorganization or optimization with no feature/fix behavior change
- `test`: Adding or fixing tests (e.g., `test(e2e): add validation check for duplicate booking`)

### Database Management & Seeding
This project uses Node.js's built-in SQLite engine, which requires no external database setup.
- **Local Data storage**: DB files are created inside the `data/` directory (e.g., `data/konfident.db`).
- **Database Seeding**: Run `npm run seed` to reset the database and seed it with demo accounts.
- **Database Migration**: Schema changes must be written directly into `src/db.js` under the table creation section using safe `CREATE TABLE IF NOT EXISTS` or `ALTER TABLE` statements.

### Environment & Run Configurations
Ensure the following variables are defined or considered for production deployment:
- `DB_PATH`: Custom database file location path.
- `SESSION_SECRET`: Session cookie encryption key (always customize this in production!).

---

## 2. Agent Skills & Customizations Instructions

Antigravity and other agent assistants use the `.agents/` folder at the root of the workspace to discover project-specific rules, guidelines, and skills.

### Folder Structure
- `.agents/rules/`: Standalone markdown files containing instructions loaded automatically by the agent.
- `.agents/skills/`: Custom or installed runbooks and workflows providing advanced agent capabilities.

### Discovering and Installing Skills
You can use the Skills CLI (`npx skills`) to search and install modular capability packages:
- **Search for skills**: `npx skills find [query]` (e.g. `npx skills find playwright`)
- **Add a skill**: `npx skills add <owner/repo@skill> -y` (e.g. `npx skills add anthropics/skills@webapp-testing -y`)
- **Update skills**: `npx skills update`

### Guidelines for Writing Custom Skills
If your team performs certain repetitive workflows (e.g., deployment, release verification, log analysis), create a custom skill:
1. Initialize the skill folder:
   ```bash
   npx skills init my-workflow-skill
   ```
2. Write a `SKILL.md` inside `.agents/skills/my-workflow-skill/` with a YAML header containing name and description.
3. Check it into version control to share it with the team.
