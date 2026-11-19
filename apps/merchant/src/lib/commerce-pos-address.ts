import { z } from 'zod';
import type { Env } from '../types';
import type { CheckoutInput } from './commerce-core';
import { ghnRequest } from './ghn-shipping';
import { pancakeRequest } from './commerce-pancake-api';
import { ShippingError,type ShippingConfig } from './smart-shipping';
import {shippingLocationConfiguration} from './shipping-registry';

const normalized = (name: string) => name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D')
  .toLowerCase().replace(/^(tinh|thanh pho|tp\.?|quan|huyen|thi xa|phuong|xa|thi tran)\s+/g, '').replace(/[^a-z0-9]/g, '');
function unique<T>(list: T[], predicate: (item: T) => boolean): T {
  const matches = list.filter(predicate);
  if (matches.length !== 1) throw new ShippingError('pos_address_unmapped', 409, 'Không thể đối chiếu duy nhất địa chỉ GHN với Pancake. Shop cần kiểm tra địa chỉ.');
  return matches[0];
}
const geo = z.object({ data: z.array(z.object({ id: z.string(), name: z.string() })) });

/** Resolve each tier within its verified parent; GHN IDs are never sent as POS IDs. */
export async function resolvePosAddress(env: Env, recipient: CheckoutInput['recipient'], config:ShippingConfig=shippingLocationConfiguration(env)) {
  const provinces = z.array(z.object({ ProvinceID: z.number(), ProvinceName: z.string(), NameExtension: z.array(z.string()).nullish() }))
    .parse(await ghnRequest(config, 'master-data/province', {}, undefined, 'GET'));
  const province = unique(provinces, p => [p.ProvinceName, ...(p.NameExtension || [])].some(n => normalized(n) === normalized(recipient.city)));
  const districts = z.array(z.object({ DistrictID: z.number(), ProvinceID: z.number(), DistrictName: z.string() }))
    .parse(await ghnRequest(config, 'master-data/district', { province_id: province.ProvinceID }, undefined, 'GET'));
  const district = unique(districts, d => d.DistrictID === recipient.district_id && d.ProvinceID === province.ProvinceID);
  const wards = z.array(z.object({ WardCode: z.string(), DistrictID: z.number(), WardName: z.string() }))
    .parse(await ghnRequest(config, 'master-data/ward', { district_id: district.DistrictID }, undefined, 'GET'));
  const ward = unique(wards, w => w.WardCode === recipient.ward_code && w.DistrictID === district.DistrictID);
  const posProvince = unique(geo.parse(await pancakeRequest(env, '/geo/provinces?country_code=84', undefined, undefined, true)).data,
    p => normalized(p.name) === normalized(province.ProvinceName));
  const posDistrict = unique(geo.parse(await pancakeRequest(env, '/geo/districts?province_id=' + encodeURIComponent(posProvince.id), undefined, undefined, true)).data,
    d => normalized(d.name) === normalized(district.DistrictName));
  const posWard = unique(geo.parse(await pancakeRequest(env, '/geo/communes?province_id=' + encodeURIComponent(posProvince.id) + '&district_id=' + encodeURIComponent(posDistrict.id), undefined, undefined, true)).data,
    w => normalized(w.name) === normalized(ward.WardName));
  return {
    province_id: posProvince.id, district_id: posDistrict.id, commune_id: posWard.id, country_code: '84',
    full_name: recipient.name, phone_number: recipient.phone, address: recipient.address,
    full_address: [recipient.address, ward.WardName, district.DistrictName, province.ProvinceName].join(', '),
  };
}
