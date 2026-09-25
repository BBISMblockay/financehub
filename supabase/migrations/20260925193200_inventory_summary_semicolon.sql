-- The single-statement runner rejects semicolons even inside a status label.
update public.silo_chat_saved_reports
   set queries_run[2] = replace(queries_run[2],
     'On order; no sales under this type name',
     'On order, no sales under this type name')
 where id = 'c1000000-0000-4000-a000-000000000001'
   and source = 'system'
   and queries_run[2] like '%On order; no sales under this type name%';
