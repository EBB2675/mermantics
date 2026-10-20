# Check of `broken-b-impossible-class.mmd`

**FAILED: 39 errors, 0 warnings, 2 notes**

- Boxes: 23, arrows: 37
- Ontology: `../tests/fixtures/tiny.ttl`
- Reasoner: not used (fast mode)

## Errors (39)

- **ids** box 'Root / Thing / Entity' (line 27): BFO_0000001 is not in the ontology

  ```
  http://purl.obolibrary.org/obo/BFO_0000001
  ```
- **ids** box 'Activity' (line 33): BFO_0000015 is not in the ontology

  ```
  http://purl.obolibrary.org/obo/BFO_0000015
  ```
- **ids** box 'Computation' (line 35): PMD_0000583 is not in the ontology

  ```
  https://w3id.org/pmd/co/PMD_0000583
  ```
- **ids** box 'Entity' (line 47): BFO_0000002 is not in the ontology

  ```
  http://purl.obolibrary.org/obo/BFO_0000002
  ```
- **ids** box 'Context' (line 49): IAO_0000030 is not in the ontology

  ```
  http://purl.obolibrary.org/obo/IAO_0000030
  ```
- **ids** box 'material entity' (line 61): BFO_0000040 is not in the ontology

  ```
  http://purl.obolibrary.org/obo/BFO_0000040
  ```
- **ids** box 'Simulation' (line 69): PMD_0000933 is not in the ontology

  ```
  https://w3id.org/pmd/co/PMD_0000933
  ```
- **ids** box 'Analysis' (line 71): PMD_0000583 is not in the ontology

  ```
  https://w3id.org/pmd/co/PMD_0000583
  ```
- **ids** box 'WorkflowRun' (line 73): PMD_0000016 is not in the ontology

  ```
  https://w3id.org/pmd/co/PMD_0000016
  ```
- **ids** box 'ComputationalMethod' (line 83): PMD_0000931 is not in the ontology

  ```
  https://w3id.org/pmd/co/PMD_0000931
  ```
- **ids** box 'SimulationSettings' (line 94): IAO_0000033 is not in the ontology

  ```
  http://purl.obolibrary.org/obo/IAO_0000033
  ```
- **ids** box 'Software' (line 102): IAO_0000010 is not in the ontology

  ```
  http://purl.obolibrary.org/obo/IAO_0000010
  ```
- **ids** box 'WorkflowDefinition' (line 104): PMD_0000012 is not in the ontology

  ```
  https://w3id.org/pmd/co/PMD_0000012
  ```
- **ids** box 'SimulatedSystem' (line 113): BFO_0000040 is not in the ontology

  ```
  http://purl.obolibrary.org/obo/BFO_0000040
  ```
- **ids** box 'Pseudopotential' (line 121): IAO_0000030 is not in the ontology

  ```
  http://purl.obolibrary.org/obo/IAO_0000030
  ```
- **ids** box 'InteratomicPotential' (line 123): IAO_0000030 is not in the ontology

  ```
  http://purl.obolibrary.org/obo/IAO_0000030
  ```
- **ids** box 'CalculatedProperty' (line 132): IAO_0000027 is not in the ontology

  ```
  http://purl.obolibrary.org/obo/IAO_0000027
  ```
- **ids** box 'qudt scalar quantity value' (line 134): PMD_0080205 is not in the ontology

  ```
  https://w3id.org/pmd/co/PMD_0080205
  ```
- **ids** box 'material' (line 143): PMD_0000000 is not in the ontology

  ```
  https://w3id.org/pmd/co/PMD_0000000
  ```
- **ids** box 'HPC' (line 145): PMD_0000582 is not in the ontology

  ```
  https://w3id.org/pmd/co/PMD_0000582
  ```
- **ids** box 'ATOMISTIC_CALC_TYPE' (line 154): PMD_0000956 is not in the ontology

  ```
  https://w3id.org/pmd/co/PMD_0000956
  ```
- **ids** box 'ATOMISTIC_CALC_TYPE' (line 154): PMD_0000862 is not in the ontology

  ```
  https://w3id.org/pmd/co/PMD_0000862
  ```
- **ids** box 'ATOMISTIC_CALC_TYPE' (line 154): PMD_0000504 is not in the ontology

  ```
  https://w3id.org/pmd/co/PMD_0000504
  ```
- **ids** box 'ATOMISTIC_CALC_TYPE' (line 154): PMD_0000631 is not in the ontology

  ```
  https://w3id.org/pmd/co/PMD_0000631
  ```
- **ids** box 'ATOMISTIC_CALC_TYPE' (line 154): PMD_0000933 is not in the ontology

  ```
  https://w3id.org/pmd/co/PMD_0000933
  ```
- **ids** arrow Simulation -> SimSystem (line 162): OBI_0000293 is not in the ontology

  ```
  http://purl.obolibrary.org/obo/OBI_0000293
  ```
- **ids** arrow Simulation -> SimSystem (line 164): OBI_0000299 is not in the ontology

  ```
  http://purl.obolibrary.org/obo/OBI_0000299
  ```
- **ids** arrow Simulation -> Pseudo (line 168): OBI_0000293 is not in the ontology

  ```
  http://purl.obolibrary.org/obo/OBI_0000293
  ```
- **ids** arrow Simulation -> Interatomic (line 170): OBI_0000293 is not in the ontology

  ```
  http://purl.obolibrary.org/obo/OBI_0000293
  ```
- **ids** arrow Simulation -> CalcProp (line 174): OBI_0000299 is not in the ontology

  ```
  http://purl.obolibrary.org/obo/OBI_0000299
  ```
- **ids** arrow Simulation -> Method (line 178): RO_0000059 is not in the ontology

  ```
  http://purl.obolibrary.org/obo/RO_0000059
  ```
- **ids** arrow Simulation -> SimSettings (line 180): RO_0000059 is not in the ontology

  ```
  http://purl.obolibrary.org/obo/RO_0000059
  ```
- **ids** arrow Simulation -> Software (line 182): RO_0000059 is not in the ontology

  ```
  http://purl.obolibrary.org/obo/RO_0000059
  ```
- **ids** arrow Simulation -> HPC (line 186): RO_0000057 is not in the ontology

  ```
  http://purl.obolibrary.org/obo/RO_0000057
  ```
- **ids** arrow Simulation -> WorkflowRun (line 190): BFO_0000050 is not in the ontology

  ```
  http://purl.obolibrary.org/obo/BFO_0000050
  ```
- **ids** arrow WorkflowRun -> WorkflowDef (line 192): RO_0000059 is not in the ontology

  ```
  http://purl.obolibrary.org/obo/RO_0000059
  ```
- **ids** arrow CalcProp -> SimSystem (line 202): IAO_0000136 is not in the ontology

  ```
  http://purl.obolibrary.org/obo/IAO_0000136
  ```
- **ids** arrow CalcProp -> ValueSpec (line 204): OBI_0001938 is not in the ontology

  ```
  http://purl.obolibrary.org/obo/OBI_0001938
  ```
- **ids** arrow SimSystem -> Material (line 208): IAO_0000136 is not in the ontology

  ```
  http://purl.obolibrary.org/obo/IAO_0000136
  ```

## Notes (2)

- **ids** arrow Simulation -> CalcType (line 196): arrow has no ontology ID, not checked (calculation_type local vocabulary field)
- **vocabulary** arrow Simulation -> CalcType (line 196): cannot check 'ATOMISTIC_CALC_TYPE': 'Simulation' has no ontology alignment
