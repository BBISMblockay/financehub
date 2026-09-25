-- The read-only query runner rejects semicolons even inside SQL string literals.
-- Creative Performance's ad-level query had one in a media-status label.
update public.silo_chat_saved_reports
   set queries_run[3] = replace(queries_run[3],
     'Thumbnail link expired; re-sync needed',
     'Thumbnail link expired - re-sync needed')
 where id = 'c3000000-0000-4000-a000-00000000000a'
   and source = 'system'
   and queries_run[3] like '%Thumbnail link expired; re-sync needed%';
