-- What the customer reads about the driver: مندوب التوصيل (not الطيار)
create or replace function everwake.default_settings()
returns jsonb language sql immutable as $$
  select jsonb_build_object(
    'payment_methods', jsonb_build_array('cash'),
    'required_fields', jsonb_build_object(
      'delivery', jsonb_build_array('phone_confirmed', 'full_name', 'delivery_method', 'address_area', 'address_street',
                                    'address_building', 'address_floor', 'address_apartment', 'payment_method'),
      'pickup',   jsonb_build_array('phone_confirmed', 'full_name', 'delivery_method'),
      'unknown',  jsonb_build_array('phone_confirmed', 'full_name', 'delivery_method')),
    'max_delivery_km', 15,
    'require_zone_for_delivery', true,
    'accept_orders_when_closed', false,
    'human_auto_release_minutes', 30,
    'phone_reply_takes_over', true,
    'auto_takeover_on_handoff', false,
    'send_order_ticket', true,
    'ops_whatsapp', '',
    'test_numbers', jsonb_build_array(),
    'aggregator_commission_percent', 25,
    'allowed_links', jsonb_build_array(),
    'templates', jsonb_build_object(
      'pause_apology_ar', 'أهلاً {name} 🙏 معلش جداً، خط الطلبات على الواتساب واقف مؤقتاً بسبب ضغط الطلبات. أول ما نرجع هنبعتلك رسالة هنا على طول علشان تطلب براحتك. متشكرين لصبرك.',
      'pause_apology_en', 'Hi {name}, we are really sorry 🙏 Our WhatsApp ordering line is paused for a little while because we are very busy. We will message you right here as soon as we are back so you can order. Thank you for your patience.',
      'resume_notice_ar', 'أهلاً {name} 👋 رجعنا نستقبل الطلبات على الواتساب! متشكرين جداً إنك استنيتنا، ابعتلنا طلبك وإحنا معاك.',
      'resume_notice_en', 'Hi {name} 👋 We are back and taking orders on WhatsApp again! Thank you so much for waiting, just send us what you would like.',
      'status_accepted_ar', 'تمام 👨‍🍳 طلبك رقم {order_no} اتأكد من فرع {branch} وبيتجهز دلوقتي.{eta}',
      'status_accepted_en', 'Great 👨‍🍳 Your order {order_no} is confirmed by our {branch} branch and is being prepared now.{eta}',
      'status_ready_ar', 'طلبك رقم {order_no} جاهز للاستلام من فرع {branch} ✅',
      'status_ready_en', 'Your order {order_no} is ready for pickup at our {branch} branch ✅',
      'status_out_for_delivery_ar', 'طلبك رقم {order_no} خرج مع مندوب التوصيل وفي الطريق ليك 🛵',
      'status_out_for_delivery_en', 'Your order {order_no} is out for delivery and on its way to you 🛵',
      'status_delivered_ar', 'بالهنا والشفا! لو احتجت أي حاجة إحنا هنا.',
      'status_delivered_en', 'Enjoy your meal! If you need anything, we are right here.',
      'status_rejected_ar', 'معلش جداً، مقدرناش ننفذ طلبك رقم {order_no}.{reason} لو تحب نساعدك في طلب تاني إحنا موجودين.',
      'status_rejected_en', 'We are really sorry, we could not fulfil your order {order_no}.{reason} If you would like help with another order, we are here.',
      'status_cancelled_ar', 'طلبك رقم {order_no} اتلغى.{reason} لو حابب تطلب تاني إحنا موجودين.',
      'status_cancelled_en', 'Your order {order_no} has been cancelled.{reason} If you would like to order again, we are here.'))
$$;

create or replace function everwake.driver_line(o everwake.orders, p_lang text)
returns text language plpgsql stable as $$
declare d everwake.drivers%rowtype; e jsonb; v_local text;
begin
  if o.driver_id is null then return null; end if;
  select * into d from everwake.drivers where id = o.driver_id;
  if not found then return null; end if;
  v_local := case when d.phone like '20%' then '0' || substr(d.phone, 3) else '+' || d.phone end;
  if d.last_loc_at > now() - interval '3 minutes' then
    e := everwake.delivery_estimate(o.tenant_id, d.last_lat, d.last_lng,
                                    (o.location ->> 'lat')::double precision, (o.location ->> 'lng')::double precision);
  end if;
  if p_lang = 'en' then
    return 'Your driver: ' || d.name || ' — ' || v_local
           || case when e is not null then ' · about ' || (e ->> 'min') || ' min away' else '' end;
  end if;
  return 'مندوب التوصيل: ' || d.name || ' — ' || v_local
         || case when e is not null then ' · هيوصلك خلال حوالي ' || (e ->> 'min') || ' دقيقة' else '' end;
end $$;

create or replace function everwake.driver_ping(p_token text, p_lat double precision, p_lng double precision,
                                                p_accuracy real default null)
returns jsonb language plpgsql as $$
declare
  d  everwake.drivers%rowtype := everwake.driver_from_token(p_token);
  o  everwake.orders%rowtype;
  e  jsonb;
  n  int := 0;
  v_near int;
  v_lang text;
  res jsonb := '[]'::jsonb;
begin
  if p_lat is null or p_lng is null or abs(p_lat) > 90 or abs(p_lng) > 180 then raise exception 'bad position'; end if;
  update everwake.drivers set last_lat = p_lat, last_lng = p_lng, last_accuracy_m = p_accuracy, last_loc_at = now()
   where id = d.id;
  v_near := coalesce((select nullif(everwake.merged_settings(t.settings) ->> 'driver_near_minutes', '')::int
                        from everwake.tenants t where t.id = d.tenant_id), 5);
  for o in select * from everwake.orders where driver_id = d.id and status = 'out_for_delivery' for update loop
    e := everwake.delivery_estimate(o.tenant_id, p_lat, p_lng,
                                    (o.location ->> 'lat')::double precision, (o.location ->> 'lng')::double precision);
    continue when e is null;
    update everwake.orders
       set delivery_km_left = (e ->> 'km')::numeric, delivery_eta_min = (e ->> 'min')::int, delivery_track_at = now()
     where id = o.id;
    -- close: tell the customer once (not when they were this close at pick-up: that message said it)
    if o.near_notified_at is null and (e ->> 'min')::int <= v_near then
      update everwake.orders set near_notified_at = now() where id = o.id;
      if o.out_for_delivery_at < now() - interval '2 minutes' then
        v_lang := everwake.customer_language(o.tenant_id, o.wa_id);
        perform everwake.queue_customer_message(o.tenant_id, o.wa_id, 'order_status',
          case when v_lang = 'en' then '🛵 ' || d.name || ' is almost there — about ' || (e ->> 'min') || ' min away.'
               else '🛵 مندوب التوصيل ' || d.name || ' قرّب يوصلك — حوالي ' || (e ->> 'min') || ' دقايق.' end);
        n := n + 1;
      end if;
    end if;
    res := res || jsonb_build_object('order_id', o.id, 'km', e -> 'km', 'min', e -> 'min');
  end loop;
  return jsonb_build_object('orders', res, 'notified', n);
end $$;
