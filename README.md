![Screenshot](screenshot.png)

# Harness

A fairly simple UI wrapper that makes it easier to manage a bunch of LLM coding (claude code) worktrees all at once.

## Why did I build this

Honestly I have been using [Conductor](https://www.conductor.build) for a while as a fairly happy customer, but some rough edges have really started to annoy me so on a random Thursday morning I decided to build my own version of it that works the way I want to. Oh yeah did I mention:

> This app is entirely vibe coded - I literally haven't opened the code once. Future travelers be warned

# How's it work?

This app is specifically designed to be an easy way to do the sort of ADD fueled multi-worktree development that I have been in-to these days. Along the left you can see all the worktrees you have, and each worktree has it's own claude, additional terminals and PR display.

The main benefit of this is that your worktrees stay organized, and it's very obvious when one of your many claudes needs your attention (the dot will change colors)

## Worktrees

This app assumes that you are going to want to use worktrees (otherwise what's the point)

It will create a worktree directory at `../<your repo folder>-worktree` and start making worktrees there. This directory will probably be changable at some point

# "Roadmap"

 [x] Initial functionality
 [ ] Settings, configurability, etc
 [ ] OTA Updates
 [ ] Better persistence (PTYs don't really stay if you kill the app, which can be a bit frustrating)
 [ ] Support other LLM CLI Tools - Honestly I currently only use Claude so this probably won't happen unless I
 [ ] Notifications when cluades are ready for you (maybe peon noises?)
 [ ] Whatever else people want - add a github issue or email me directly!

# Contributing

I mean if you want? I think you probably just want to tell claude to download it and make whatever changes you want
