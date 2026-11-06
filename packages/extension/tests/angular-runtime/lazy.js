import { Component } from '@angular/core';
export class LazyComponent {}
Component({selector:'fixture-lazy',standalone:true,template:'<button data-testid="lazy">Lazy</button>'})(LazyComponent);
