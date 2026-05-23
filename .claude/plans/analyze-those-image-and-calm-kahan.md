# Plan: Reproduce Role Framework Images as HTML + Markdown

## Context

User provided two images of a "Role Framework: Expert Track" career ladder. Need to reproduce as:
1. `role-framework.html` — pixel-close visual reproduction
2. `role-framework.md` — structured content representation

## Image 1: Expert Track Matrix

Grid showing 9 competencies × 13 role levels with 5-dot proficiency indicators.

**Three competency groups:**
- Foundational Growth (magenta pill): Self Management, Leadership, Experience & Variety
- Collaborative and Strategic (dark navy pill): Networking & Collaboration, Customer Engagement, Impact & Accountability
- Execution & Mastery (red/magenta pill): Strategy & Innovation, Project Management, Technical Expertise

**Role levels (top to bottom):**
- Role 5: N/A
- Role 4: Senior Fellow, Scientist / Engineer Fellow
- Role 3: Principal Scientist / Engineer, Senior Scientist / Engineer
- Role 2: Scientist / Eng III, Scientist / Eng II, Scientist / Eng I
- Role 1: Associate Scientist / Engineer IIII, Senior Associate Scientist (Senior Technician III), Associate Scientist (Senior Technician II)
- Core 3: Senior Technician, Technician III, Technician II

## Image 2: Dual Track Comparison

Side-by-side showing Expert track (includes Core) and Manager track with role-level alignment.

**Manager track roles:**
- Role 5: Executive Director, Senior Director
- Role 4: Director, Senior Associate Director
- Role 3: Associate Director, Senior Manager, Manager
- Role 2: Associate Manager
- Role 1: N/A

## Implementation

### Files to create:
1. `/home/m306213/workspace/maestro/role-framework.html` — Self-contained HTML with inline CSS
   - Reproduce matrix table with dot indicators (filled/empty circles)
   - Reproduce dual-track comparison card
   - Match colors: magenta (#9b1b7a), dark navy (#1a1a2e), purple badges
   - Use CSS grid for matrix layout

2. `/home/m306213/workspace/maestro/role-framework.md` — Markdown tables capturing all content

### Verification
- Open HTML in browser to verify visual match
- Confirm all role names, competency descriptions, and dot patterns present
