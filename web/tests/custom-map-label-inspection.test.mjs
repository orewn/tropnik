import test from 'node:test';
import assert from 'node:assert/strict';
import {MAX_RECORDED_MAP_LABELS,MAP_LABEL_SAMPLE_LIMIT,parseMapLabelInspectionRequest,selectRecordedMapLabels} from '../lib/custom-map-label-inspection.ts';

const record=(id,label='Другой объект')=>({id:String(id),label,coordinate:[28.5,60.3],visible:false,reason:'outside-viewport'});
const request={schemaVersion:1,names:['Приморск','Выборг'],limit:100};

test('a named last-frame query finds actual decisions beyond the unrelated general sample',()=>{
 const records=Array.from({length:MAX_RECORDED_MAP_LABELS},(_,i)=>record(i));
 records[MAP_LABEL_SAMPLE_LIMIT+12]={...record('primorsk','Приморск'),visible:true,reason:'drawn',width:80,rect:{left:20,top:30,right:110,bottom:50}};
 records[records.length-1]=record('vyborg','Выборг');
 const result=selectRecordedMapLabels(records,records.length,request);
 assert.equal(result.truncated,false);assert.equal(result.totalCandidates,MAX_RECORDED_MAP_LABELS);assert.equal(result.matchingCandidates,2);
 assert.deepEqual(result.candidates.map(item=>item.id),['primorsk','vyborg']);
 result.candidates[0].coordinate[0]=0;result.candidates[0].rect.left=0;result.names.push('Changed');
 assert.equal(records[MAP_LABEL_SAMPLE_LIMIT+12].coordinate[0],28.5);assert.equal(records[MAP_LABEL_SAMPLE_LIMIT+12].rect.left,20);assert.equal(request.names.length,2);
});

test('too many matching decisions and unretained source decisions remain explicitly truncated',()=>{
 const records=Array.from({length:101},(_,i)=>record(i,'Приморск'));
 const full=selectRecordedMapLabels(records,101,request);assert.equal(full.truncated,true);assert.equal(full.matchingCandidates,101);assert.equal(full.candidates.length,100);
 const incomplete=selectRecordedMapLabels([record(1,'Выборг')],2,request);assert.equal(incomplete.truncated,true);
 const empty=selectRecordedMapLabels([record(1)],1,request);assert.equal(empty.truncated,false);assert.deepEqual(empty.candidates,[]);
});

test('invalid or oversized requests cannot expand the retained/rendered decision budget',()=>{
 for(const bad of [null,{}, {...request,schemaVersion:2},{...request,names:[]},{...request,names:['a','a']},{...request,names:['x'.repeat(161)]},{...request,names:Array.from({length:101},(_,i)=>String(i))},{...request,limit:0},{...request,limit:101},{...request,limit:1.5}])assert.equal(parseMapLabelInspectionRequest(bad),null);
 assert.equal(selectRecordedMapLabels([record(0)],0,request),null);
 assert.equal(selectRecordedMapLabels(Array.from({length:MAX_RECORDED_MAP_LABELS+1},(_,i)=>record(i)),MAX_RECORDED_MAP_LABELS+1,request),null);
});
