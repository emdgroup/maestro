---
title: "Improve project picker screen. The select project action should check if selected project uses git, if not it should initialize git in the project. Next to the "select" button, add a "clone project" button that ask user for a git url and a target path and then clone the remote project into the target path. Next to the "clone project" button add a "create project" button that will ask for the name of the project and the target path. It will simply create the folder and initialize git inside."
status: pending
priority: P2
source: "promoted from /gsd:note"
created: 2026-03-28
theme: general
---

## Goal

Improve project picker screen. The select project action should check if selected project uses git, if not it should initialize git in the project. Next to the "select" button, add a "clone project" button that ask user for a git url and a target path and then clone the remote project into the target path. Next to the "clone project" button add a "create project" button that will ask for the name of the project and the target path. It will simply create the folder and initialize git inside.

## Context

Promoted from quick note captured on 2026-03-28 00:00.

## Acceptance Criteria

- [ ] Select action checks if project uses git and initializes git if not
- [ ] "Clone project" button added, prompts for git URL and target path, clones repo
- [ ] "Create project" button added, prompts for name and target path, creates folder and initializes git
