SET search_path = public, pg_catalog;
SELECT definition FROM (
SELECT jsonb_build_array('column', c.relname, a.attname, format_type(a.atttypid,a.atttypmod), a.attnotnull, a.attidentity, a.attgenerated, pg_get_expr(d.adbin,d.adrelid), col_description(c.oid,a.attnum))::text AS definition
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid
LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m') AND a.attnum>0 AND NOT a.attisdropped
UNION ALL
SELECT jsonb_build_array('relation',c.relname,c.relkind,c.relrowsecurity,c.relforcerowsecurity,c.reloptions,obj_description(c.oid,'pg_class'))::text
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','S')
UNION ALL
SELECT jsonb_build_array('constraint',c.conrelid::regclass::text,c.conname,pg_get_constraintdef(c.oid),c.convalidated)::text
FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname='public'
UNION ALL
SELECT jsonb_build_array('index',c.relname,pg_get_indexdef(i.indexrelid),i.indisvalid,i.indisready)::text
FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'
UNION ALL
SELECT jsonb_build_array('function',p.proname,pg_get_function_identity_arguments(p.oid),pg_get_functiondef(p.oid))::text
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prokind IN ('f','p','w')
UNION ALL
SELECT jsonb_build_array('trigger',t.tgrelid::regclass::text,t.tgname,pg_get_triggerdef(t.oid),t.tgenabled)::text
FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT t.tgisinternal
UNION ALL
SELECT jsonb_build_array('enum',t.typname,e.enumlabel,e.enumsortorder)::text
FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public'
UNION ALL
SELECT jsonb_build_array('view',c.relname,pg_get_viewdef(c.oid))::text
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('v','m')
UNION ALL
SELECT jsonb_build_array('policy',tablename,policyname,permissive,roles,cmd,qual,with_check)::text FROM pg_policies WHERE schemaname='public'
UNION ALL
SELECT jsonb_build_array('sequence',sequencename,data_type,start_value,min_value,max_value,increment_by,cycle,cache_size)::text FROM pg_sequences WHERE schemaname='public'
) definitions ORDER BY definition;
