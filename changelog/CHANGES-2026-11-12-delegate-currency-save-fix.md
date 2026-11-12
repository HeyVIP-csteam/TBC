# 2026-11-12 — Delegated admins couldn't save other accounts' permissions

## Problem
An admin with "Manage access for others" (e.g. cszeshan, currency PKR only)
editing an agent (csrashid) got "You can't grant access to INR, PHP — you
don't have access to those currencies yourself." on every Save, even when
not touching currencies.

## Cause (index.html)
The Currencies picker only shows the editor's own currencies (PKR). When
every SHOWN pill was selected, the form sent `allowedCountries: "all"`,
which the server reads as INR+PKR+PHP → INR/PHP counted as newly granted
→ rejected. Same bug in Create Account.

## Fix
Send "all" only when every currency in the system is selected; otherwise
send the actual list (e.g. ["PKR"]). Server rules unchanged (still blocks
granting a currency the editor doesn't have).

## Tested
PKR-only delegate → PKR agent: sends ["PKR"] (was "all");
agent with INR+PKR keeps ["PKR","INR"]; all-currency admin still sends "all".
