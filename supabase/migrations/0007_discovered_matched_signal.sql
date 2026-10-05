-- 0007: show WHY a host got its type (transparency). A naive user saw
-- "almost everything → music", because the port 22 rule (SSH is everywhere) caught
-- everything — but did not see WHICH signal fired. matched_signal = short description of
-- the winning signal (e.g. 'port:22', 'banner:MikroTik RouterOS') shown in the drawer.
alter table public.discovered_hosts add column if not exists matched_signal text;
