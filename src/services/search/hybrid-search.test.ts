import {test} from 'node:test';import assert from 'node:assert/strict';import {cosine} from './hybrid-search.js';
test('cosine handles empty, orthogonal and matching vectors',()=>{assert.equal(cosine([],[]),0);assert.equal(cosine([1,0],[0,1]),0);assert.equal(cosine([1,0],[2,0]),1);assert.equal(cosine([0,0],[0,0]),0);});
