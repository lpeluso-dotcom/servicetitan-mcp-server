import {beforeEach,describe,it,expect,vi} from 'vitest';
const read=vi.hoisted(()=>vi.fn());vi.mock('../../st',()=>({readST:read}));
import {estimate_reference_evidence as tool} from './estimate_reference_evidence';
const ctx={actor:'test',correlation:'test'};
const ref=(id=1)=>({id,customerId:11,jobId:12,locationId:13,projectId:null,modifiedOn:'2026-10-10',name:'private-name'});
const run=(estimateIds=[1])=>tool.handler({} as never,{estimateIds},ctx) as Promise<any>;
beforeEach(()=>read.mockReset());
describe('exact estimate listing/detail evidence',()=>{
 it('compares the same IDs, preserves null, and does not expose unrelated source fields',async()=>{
  read.mockResolvedValueOnce({data:[ref()],hasMore:false,page:1,totalCount:1}).mockResolvedValueOnce(ref());
  const result=await run();expect(result.comparisons[0].comparison).toBe('references_agree');
  expect(result.comparisons[0].detail.fields.projectId).toBeNull();expect(JSON.stringify(result)).not.toContain('private-name');
  expect(result).toMatchObject({listing_complete:true,source_reads_atomic:false,identity_changes_authorized:false});
  expect(read.mock.calls[0][3]).toEqual({ids:'1',active:'Any',page:1,pageSize:200,includeTotal:true});
 });
 it('preserves pagination and compares differences without selecting a winner',async()=>{
  read.mockResolvedValueOnce({data:[ref()],hasMore:true,page:1,totalCount:2}).mockResolvedValueOnce({data:[ref(2)],hasMore:false,page:2,totalCount:2}).mockResolvedValueOnce({...ref(),locationId:99}).mockResolvedValueOnce(ref(2));
  const result=await run([1,2]);expect(result.pages_fetched).toBe(2);expect(result.comparisons[0]).toMatchObject({comparison:'source_representations_differ',reference_differences:['locationId']});expect(read.mock.calls[1][3].ids).toBe('1,2');
 });
 it.each([{data:[ref(9)],hasMore:false},{data:[ref(),ref()],hasMore:false},{data:[ref()]},{data:null,hasMore:false},{data:[ref()],hasMore:false,totalCount:2},{data:[ref()],hasMore:false,page:2}])('rejects malformed, filtered-out, duplicated or incomplete listing responses',async response=>{
  read.mockResolvedValueOnce(response);await expect(run()).rejects.toThrow();expect(read).toHaveBeenCalledTimes(1);
 });
 it('discloses missing records and fields instead of assuming null or equal',async()=>{
  read.mockResolvedValueOnce({data:[],hasMore:false,totalCount:0}).mockResolvedValueOnce(ref());
  expect((await run()).comparisons[0].comparison).toBe('absent_from_complete_listing');
  const partial=ref();delete (partial as any).projectId;
  read.mockResolvedValueOnce({data:[partial],hasMore:false}).mockResolvedValueOnce(ref());
  expect((await run()).comparisons[0].comparison).toBe('reference_fields_unavailable');
 });
 it('rejects duplicate inputs, mismatched details, unstable totals and page caps',async()=>{
  await expect(run([1,1])).rejects.toThrow();expect(read).not.toHaveBeenCalled();
  read.mockResolvedValueOnce({data:[ref()],hasMore:false}).mockResolvedValueOnce(ref(2));await expect(run()).rejects.toThrow('different ID');
  read.mockReset().mockResolvedValueOnce({data:[],hasMore:true,totalCount:1}).mockResolvedValueOnce({data:[],hasMore:false,totalCount:2});await expect(run()).rejects.toThrow('changed during');
  read.mockReset().mockResolvedValue({data:[],hasMore:true});await expect(run()).rejects.toThrow('pagination cap');expect(read).toHaveBeenCalledTimes(5);
 });
});
