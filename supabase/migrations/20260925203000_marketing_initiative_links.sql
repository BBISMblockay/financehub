-- Marketing links may point at one initiative inside their launch.
-- Older launch-level links stay valid with channel_item_id = null.
-- A composite FK prevents a link from naming an initiative in another launch
-- or company, even if a client bypasses the picker. Moving an initiative moves
-- its marketing links along with it; deleting one leaves launch-level links.

alter table public.launch_channel_items
  add constraint launch_channel_items_link_parent_key
  unique (id, launch_id, company_entity_id);

alter table public.launch_system_links
  add column channel_item_id uuid;

alter table public.launch_system_links
  add constraint launch_system_links_initiative_requires_company
  check (channel_item_id is null or company_entity_id is not null);

alter table public.launch_system_links
  add constraint launch_system_links_initiative_parent_fkey
  foreign key (channel_item_id, launch_id, company_entity_id)
  references public.launch_channel_items (id, launch_id, company_entity_id)
  on update cascade
  on delete set null (channel_item_id);

create index launch_system_links_channel_item_idx
  on public.launch_system_links (channel_item_id)
  where channel_item_id is not null;

comment on column public.launch_system_links.channel_item_id is
  'Optional exact initiative within launch_id; composite FK enforces launch and company consistency.';
